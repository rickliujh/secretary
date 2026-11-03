/**
 * Live eval of `note_triage` (Phase 29, D65) against a real model. Skipped
 * unless configured, with the same variables as the intake eval
 * (`eval.live.test.ts`). The task is fast tier: SECRETARY_EVAL_FAST_MODEL is
 * used when set, else the standard model (GLM 5.3 Flash on OpenRouter, the
 * project's eval model, serves both):
 *
 *   SECRETARY_EVAL_KIND=openai-compatible
 *   SECRETARY_EVAL_BASE_URL=https://openrouter.ai/api/v1
 *   SECRETARY_EVAL_API_KEY=...
 *   SECRETARY_EVAL_STANDARD_MODEL=z-ai/glm-5.3-flash
 *   SECRETARY_EVAL_FAST_MODEL=z-ai/glm-5.3-flash    # optional
 *   SECRETARY_EVAL_CASE="standup"                   # optional: cases whose name contains this
 *   SECRETARY_EVAL_CONCURRENCY=6                    # optional: cases at once
 *   SECRETARY_EVAL_EFFORT=low                       # optional: the provider's effort setting
 *   SECRETARY_EVAL_PROVIDER=deepinfra/fp4,streamlake/fp8,novita/fp8  # optional, OpenRouter
 *   bun test src/test/eval/note-eval
 *
 * Each case is one reading: the real Llm (validate -> repair -> escalate) on
 * its blocks in a fresh in-memory database, scored per block. Nothing touches
 * Jira.
 */
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { llmCalls } from "@/db/schema";
import {
  buildNoteTriagePrompt,
  buildNoteTriageSchema,
  type NoteTriageOutput,
  validateNoteTriage,
} from "@/prompts/note-triage";
import { query } from "@/services/db";
import { DbTest } from "@/services/db/test";
import { makeFetcherTest } from "@/services/http";
import { Llm } from "@/services/llm";
import { LlmLive, ModelFactoryLive } from "@/services/llm/live";
import { secretNames } from "@/services/secrets";
import { makeSecretsTest } from "@/services/secrets/test";
import { defaultSettings, ProviderSchema } from "@/services/settings/schema";
import { makeSettingsTest } from "@/services/settings/test";
import {
  afterRateLimit,
  backoffMs,
  callStats,
  describeStats,
  parseConcurrency,
  parseProviders,
  pinProvider,
  RATE_LIMIT_RETRIES,
} from "./harness";
import { NOTE_EVAL_CASES, type NoteEvalCase, noteEvalInput, scoreNoteCase } from "./note-cases";

const env = process.env;
const configured = !!(
  env.SECRETARY_EVAL_API_KEY &&
  env.SECRETARY_EVAL_BASE_URL &&
  env.SECRETARY_EVAL_STANDARD_MODEL
);
/** Of all blocks across the cases, this share must get the expected kind. */
const PASS_RATE = 0.8;
const concurrency = configured ? parseConcurrency(env.SECRETARY_EVAL_CONCURRENCY) : 1;
const pinned = parseProviders(env.SECRETARY_EVAL_PROVIDER);
const selected = env.SECRETARY_EVAL_CASE
  ? NOTE_EVAL_CASES.filter((c) => c.name.includes(env.SECRETARY_EVAL_CASE ?? ""))
  : NOTE_EVAL_CASES;

/** The model endpoint over the network, with the intake eval's provider pinning and 429 waits. */
async function modelFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input);
  const body =
    url.endsWith("/chat/completions") && typeof init?.body === "string" ? init.body : null;
  let asked = pinned;
  const send = () =>
    fetch(input, body !== null && asked ? { ...init, body: pinProvider(body, asked) } : init);
  let res = await send();
  let waits = 0;
  while (res.status === 429 && !init?.signal?.aborted) {
    const rest = body !== null && asked ? afterRateLimit(asked) : null;
    if (rest) asked = rest;
    else {
      if (waits >= RATE_LIMIT_RETRIES) break;
      await new Promise((r) => setTimeout(r, backoffMs(waits++)));
      asked = pinned;
    }
    res = await send();
  }
  return res;
}

function layer() {
  const effort = ProviderSchema.shape.effort.parse(env.SECRETARY_EVAL_EFFORT || undefined);
  const provider = ProviderSchema.parse({
    id: "eval",
    name: "Eval",
    kind: env.SECRETARY_EVAL_KIND === "openai-compatible" ? "openai-compatible" : "anthropic",
    baseUrl: env.SECRETARY_EVAL_BASE_URL,
    effort,
  });
  const model = env.SECRETARY_EVAL_FAST_MODEL || env.SECRETARY_EVAL_STANDARD_MODEL || "";
  const bind = { providerId: "eval", model };
  const base = Layer.mergeAll(
    makeSettingsTest({
      ...defaultSettings(),
      providers: [provider],
      tiers: { fast: bind, standard: bind, strong: null },
    }),
    makeSecretsTest({ [secretNames.providerApiKey("eval")]: env.SECRETARY_EVAL_API_KEY ?? "" }),
    makeFetcherTest(modelFetch),
    DbTest,
  );
  return Layer.provideMerge(LlmLive, Layer.provideMerge(ModelFactoryLive, base));
}

type Outcome = { c: NoteEvalCase; fails: string[]; error: string | null };

const runCase = (c: NoteEvalCase) =>
  Effect.gen(function* () {
    const started = Date.now();
    const llm = yield* Llm;
    const input = noteEvalInput(c);
    const ids = input.items.map((i) => i.id);
    const r = yield* Effect.either(
      llm.object<NoteTriageOutput>("note_triage", {
        schema: buildNoteTriageSchema(input.blocks.length, ids) as never,
        ...buildNoteTriagePrompt(input),
        validate: (out) => validateNoteTriage(out, input.blocks.length, ids),
      }),
    );
    const fails = scoreNoteCase(c, r._tag === "Right" ? r.right.value : null);
    const stats = callStats(yield* query((d) => d.select().from(llmCalls).all()));
    const error = r._tag === "Left" ? `${r.left.kind}: ${r.left.message}` : null;
    console.log(
      `${fails.length ? "FAIL" : "PASS"}  ${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s  ${describeStats(stats)}  ${c.name}${fails.length ? `  [${fails.join("; ").slice(0, 300)}]` : ""}`,
    );
    return { c, fails, error } satisfies Outcome;
  }).pipe(Effect.provide(layer()));

describe.skipIf(!configured)("note triage eval (live)", () => {
  test(
    `note_triage gets at least ${PASS_RATE * 100}% of the note blocks right`,
    async () => {
      const outcomes = await Effect.runPromise(Effect.forEach(selected, runCase, { concurrency }));
      const blocks = outcomes.reduce((n, o) => n + o.c.blocks.length, 0);
      const wrong = outcomes.reduce(
        (n, o) => n + (o.error ? o.c.blocks.length : o.fails.length),
        0,
      );
      console.log(`\nnote triage eval: ${blocks - wrong}/${blocks} blocks right`);
      for (const o of outcomes.filter((x) => x.error)) console.log(`  ${o.c.name}: ${o.error}`);
      expect((blocks - wrong) / blocks).toBeGreaterThanOrEqual(PASS_RATE);
    },
    20 * 60 * 1000,
  );
});

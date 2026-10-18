/**
 * Live eval of `update_work_state` (Phase 23, D61) against a real model.
 * Skipped unless configured, with the same variables as the intake eval
 * (`eval.live.test.ts`):
 *
 *   SECRETARY_EVAL_KIND=anthropic            # or openai-compatible
 *   SECRETARY_EVAL_BASE_URL=https://api.anthropic.com/v1
 *   SECRETARY_EVAL_API_KEY=...
 *   SECRETARY_EVAL_STANDARD_MODEL=claude-sonnet-5
 *   SECRETARY_EVAL_CASE="date moved"            # optional: cases whose name contains this
 *   SECRETARY_EVAL_CONCURRENCY=6                # optional: cases at once
 *   SECRETARY_EVAL_EFFORT=low                   # optional: the provider's effort setting
 *   SECRETARY_EVAL_PROVIDER=deepinfra/fp4,novita/fp8  # optional, OpenRouter: providers in order
 *   bun test src/test/eval/work-eval
 *
 * Each case runs the real Llm (validate -> repair -> escalate) on its input
 * in a fresh in-memory database; the state is scored on the fields the case
 * names. Nothing touches Jira.
 */
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { llmCalls } from "@/db/schema";
import {
  buildWorkStatePrompt,
  buildWorkStateSchema,
  toWorkState,
  validateWorkState,
  type WorkStateOutput,
} from "@/prompts/work-state";
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
import { scoreWorkCase, WORK_EVAL_CASES, type WorkEvalCase } from "./work-cases";

const env = process.env;
const configured = !!(
  env.SECRETARY_EVAL_API_KEY &&
  env.SECRETARY_EVAL_BASE_URL &&
  env.SECRETARY_EVAL_STANDARD_MODEL
);
const PASS_RATE = 0.75;
const concurrency = configured ? parseConcurrency(env.SECRETARY_EVAL_CONCURRENCY) : 1;
const pinned = parseProviders(env.SECRETARY_EVAL_PROVIDER);
const selected = env.SECRETARY_EVAL_CASE
  ? WORK_EVAL_CASES.filter((c) => c.name.includes(env.SECRETARY_EVAL_CASE ?? ""))
  : WORK_EVAL_CASES;

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
  const bind = { providerId: "eval", model: env.SECRETARY_EVAL_STANDARD_MODEL ?? "" };
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

type Outcome = { c: WorkEvalCase; fails: string[]; error: string | null; line: string };

const runCase = (c: WorkEvalCase) =>
  Effect.gen(function* () {
    const started = Date.now();
    const llm = yield* Llm;
    const r = yield* Effect.either(
      llm.object<WorkStateOutput>("update_work_state", {
        schema: buildWorkStateSchema(c.input) as never,
        ...buildWorkStatePrompt(c.input),
        validate: (out) => validateWorkState(out, c.input),
      }),
    );
    const state = r._tag === "Right" ? toWorkState(r.right.value, c.input) : null;
    const fails = scoreWorkCase(c, state);
    const stats = callStats(yield* query((d) => d.select().from(llmCalls).all()));
    const error = r._tag === "Left" ? `${r.left.kind}: ${r.left.message}` : null;
    const line = `${fails.length ? "FAIL" : "PASS"}  ${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s  ${describeStats(stats)}  ${c.name}${fails.length ? `  [${fails.join("; ").slice(0, 200)}]` : ""}`;
    console.log(line);
    return { c, fails, error, line } satisfies Outcome;
  }).pipe(Effect.provide(layer()));

describe.skipIf(!configured)("work state eval (live)", () => {
  test(
    `update_work_state passes at least ${PASS_RATE * 100}% of the work cases`,
    async () => {
      const outcomes = await Effect.runPromise(Effect.forEach(selected, runCase, { concurrency }));
      const passed = outcomes.filter((o) => o.fails.length === 0).length;
      console.log(`\nwork state eval: ${passed}/${outcomes.length} passed`);
      for (const o of outcomes.filter((x) => x.error)) console.log(`  ${o.c.name}: ${o.error}`);
      expect(passed / outcomes.length).toBeGreaterThanOrEqual(PASS_RATE);
    },
    20 * 60 * 1000,
  );
});

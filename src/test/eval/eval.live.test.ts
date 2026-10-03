/**
 * Live intake eval against a real model. Skipped unless configured:
 *
 *   SECRETARY_EVAL_KIND=anthropic            # or openai-compatible
 *   SECRETARY_EVAL_BASE_URL=https://api.anthropic.com/v1
 *   SECRETARY_EVAL_API_KEY=...
 *   SECRETARY_EVAL_STANDARD_MODEL=claude-sonnet-5
 *   SECRETARY_EVAL_FAST_MODEL=claude-haiku-4-5   # optional: also compares tiers
 *   SECRETARY_EVAL_CASE="status change"         # optional: run only cases whose name contains this
 *   SECRETARY_EVAL_CONCURRENCY=6                # optional: cases at once (1 runs them in turn)
 *   SECRETARY_EVAL_EFFORT=low                   # optional: the provider's effort setting (D52)
 *   SECRETARY_EVAL_PROVIDER=deepinfra/fp4       # optional, OpenRouter: pin the upstream provider
 *   bun test src/test/eval
 *
 * Every intake case runs in its own database and layer, several at once, and
 * prints a line when it finishes. The other live tests run beside it.
 * Jira is a stub over the fixtures, so nothing is written anywhere.
 */
import { describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { Data, Effect, Layer } from "effect";
import { renderReport } from "@/components/report/render";
import {
  dependencies,
  followups,
  intakeItems,
  jiraComments,
  jiraIssues,
  llmCalls,
  memories,
  proposals,
} from "@/db/schema";
import { Chat } from "@/services/chat";
import { ChatLive } from "@/services/chat/live";
import { Comms } from "@/services/comms";
import { CommsLive } from "@/services/comms/live";
import { draftDetail } from "@/services/comms/queries";
import { ConfluenceClientLive } from "@/services/confluence/live";
import { query } from "@/services/db";
import { DbTest } from "@/services/db/test";
import { createDependency, requestChaseDraft } from "@/services/dependencies/queries";
import { createPerson, createTeam } from "@/services/directory/queries";
import { scoreCase, signature } from "@/services/eval/score";
import { makeFetcherTest } from "@/services/http";
import { Intake } from "@/services/intake";
import { IntakeLive } from "@/services/intake/live";
import { JiraClientLive } from "@/services/jira/live";
import type { LlmErrorKind } from "@/services/llm/errors";
import { LlmLive, ModelFactoryLive } from "@/services/llm/live";
import { Planning } from "@/services/planning";
import { PlanningLive } from "@/services/planning/live";
import { describePayload, type ProposalPayload } from "@/services/proposals/schema";
import { REPORT_STYLES, Reports } from "@/services/report";
import { ReportsLive } from "@/services/report/live";
import { RetrievalLive } from "@/services/retrieval/live";
import { secretNames } from "@/services/secrets";
import { makeSecretsTest } from "@/services/secrets/test";
import { Settings } from "@/services/settings";
import { ProviderSchema, type TierBindings } from "@/services/settings/schema";
import { makeSettingsTest } from "@/services/settings/test";
import { SourcesLive } from "@/services/sources/live";
import { FIXTURE_VAULT_DIR, loadVaultFromDisk, makeObsidianCliTest } from "@/services/sources/test";
import { Sync } from "@/services/sync";
import { SyncLive } from "@/services/sync/live";
import { getState, parseSprintState, SYNC_KEYS, setState } from "@/services/sync/state";
import { drainStream, TODAY } from "@/test/helpers";
import { JIRA_BASE, jiraSettings } from "@/test/layers";
import { fixtureIssues, fixtureRoutes } from "@/test/seed";
import { json, type StubRoute, stubFetch } from "@/test/stub-fetch";
import { EVAL_CASES, EVAL_HOME, EVAL_OUTSIDE_ISSUES, type EvalCase } from "./cases";
import {
  addStats,
  backoffMs,
  type CallStats,
  callStats,
  describeStats,
  noCalls,
  parseConcurrency,
  pinProvider,
  RATE_LIMIT_RETRIES,
  stopMessage,
  stopReason,
} from "./harness";

const env = process.env;
const configured = !!(
  env.SECRETARY_EVAL_API_KEY &&
  env.SECRETARY_EVAL_BASE_URL &&
  env.SECRETARY_EVAL_STANDARD_MODEL
);
const PASS_RATE = 0.75;

// Read only when the eval runs, so a stray value cannot break the ordinary test run.
const concurrency = configured ? parseConcurrency(env.SECRETARY_EVAL_CONCURRENCY) : 1;
const effort = (() => {
  if (!configured) return "default" as const;
  const r = ProviderSchema.shape.effort.safeParse(env.SECRETARY_EVAL_EFFORT || undefined);
  if (!r.success)
    throw new Error(
      `SECRETARY_EVAL_EFFORT must be one of ${ProviderSchema.shape.effort.unwrap().options.join(", ")}`,
    );
  return r.data;
})();
const pinned = env.SECRETARY_EVAL_PROVIDER?.trim() || null;

const selected = env.SECRETARY_EVAL_CASE
  ? EVAL_CASES.filter((c) => c.name.includes(env.SECRETARY_EVAL_CASE ?? ""))
  : EVAL_CASES;

const EVAL_VAULT = {
  id: "vault",
  kind: "obsidian" as const,
  name: "Work",
  vault: "Work",
  enabled: true,
};

/** Upstream providers named in model responses (OpenRouter's `provider` field), with counts. */
const upstream = new Map<string, number>();

/** 429s the eval's model fetch waited out (see RATE_LIMIT_RETRIES). */
let rateLimitRetries = 0;

const pause = (ms: number, signal?: AbortSignal | null) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/**
 * The model endpoint over the real network. With SECRETARY_EVAL_PROVIDER set,
 * chat-completions requests carry OpenRouter's provider pin. A 429 is retried
 * with backoff a few times before the app sees it.
 */
async function modelFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = input instanceof Request ? input.url : String(input);
  const pin = pinned && url.endsWith("/chat/completions") && typeof init?.body === "string";
  const req = pin ? { ...init, body: pinProvider(String(init?.body), pinned) } : init;
  let res = await fetch(input, req);
  for (let attempt = 0; res.status === 429 && attempt < RATE_LIMIT_RETRIES; attempt++) {
    if (init?.signal?.aborted) break;
    rateLimitRetries++;
    await pause(backoffMs(attempt), init?.signal);
    res = await fetch(input, req);
  }
  if (res.ok && res.headers.get("content-type")?.includes("application/json"))
    void res
      .clone()
      .json()
      .then((j: { provider?: unknown }) => {
        if (typeof j?.provider === "string")
          upstream.set(j.provider, (upstream.get(j.provider) ?? 0) + 1);
      })
      .catch(() => undefined);
  return res;
}

/**
 * A "Blocks" link type, and the tickets outside the sync scope that cases name,
 * read once from Jira when the text mentions them (D45).
 */
function linkRoutes(): StubRoute[] {
  const base = fixtureIssues[0] as { fields: Record<string, unknown> };
  return [
    {
      match: (u) => u.pathname.endsWith("/issueLinkType"),
      respond: () =>
        json({
          issueLinkTypes: [
            { id: "10000", name: "Blocks", inward: "is blocked by", outward: "blocks" },
          ],
        }),
    },
    ...Object.entries(EVAL_OUTSIDE_ISSUES).map(([key, summary], n) => ({
      match: (u: URL) => u.pathname.endsWith(`/issue/${key}`),
      respond: () =>
        json({
          ...base,
          id: String(99000 + n),
          key,
          fields: {
            ...base.fields,
            summary,
            project: { id: "300", key: key.split("-")[0], name: "Platform" },
            issuelinks: [],
          },
        }),
    })),
  ];
}

/** Every service the live tests use, over a fresh in-memory database. */
function layerFor(tiers: TierBindings, extraRoutes: StubRoute[] = []) {
  const provider = ProviderSchema.parse({
    id: "eval",
    name: "Eval",
    kind: env.SECRETARY_EVAL_KIND === "openai-compatible" ? "openai-compatible" : "anthropic",
    baseUrl: env.SECRETARY_EVAL_BASE_URL,
    effort,
  });
  const jiraStub = stubFetch([...extraRoutes, ...linkRoutes(), ...fixtureRoutes()]);
  // Jira goes to the stub; the model provider gets real network access.
  const fetcher = makeFetcherTest((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    return url.startsWith(JIRA_BASE) ? jiraStub.fetch(input, init) : modelFetch(input, init);
  });
  const base = Layer.mergeAll(
    makeSettingsTest({
      ...jiraSettings({ trackedEpics: ["PAY-1"] }),
      dataSources: [EVAL_VAULT],
      providers: [provider],
      tiers,
    }),
    makeSecretsTest({
      [secretNames.jiraPat]: "stub",
      [secretNames.providerApiKey("eval")]: env.SECRETARY_EVAL_API_KEY ?? "",
    }),
    fetcher,
    DbTest,
  );
  const withJira = Layer.provideMerge(SyncLive, Layer.provideMerge(JiraClientLive, base));
  const withLlm = Layer.provideMerge(LlmLive, Layer.provideMerge(ModelFactoryLive, withJira));
  const withConfluence = Layer.provideMerge(ConfluenceClientLive, withLlm);
  return Layer.provideMerge(
    ChatLive,
    Layer.provideMerge(
      Layer.mergeAll(CommsLive, PlanningLive, ReportsLive),
      Layer.provideMerge(
        IntakeLive,
        Layer.provideMerge(
          Layer.merge(
            RetrievalLive,
            SourcesLive.pipe(
              Layer.provide(
                makeObsidianCliTest({ Work: loadVaultFromDisk(FIXTURE_VAULT_DIR) }).layer,
              ),
            ),
          ),
          withConfluence,
        ),
      ),
    ),
  );
}

type LiveServices = Layer.Layer.Success<ReturnType<typeof layerFor>>;

const bindAll = (model: string): TierBindings => {
  const bind = { providerId: "eval", model };
  return { fast: bind, standard: bind, strong: null };
};

/** The model calls recorded in the current database. */
const recordedCalls = Effect.map(
  query((d) => d.select().from(llmCalls).all()),
  callStats,
);

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/**
 * Runs one live test's effect in its own layer and prints how long it took
 * and how many model calls it made.
 */
async function runLive<A, E>(
  label: string,
  effect: Effect.Effect<A, E, LiveServices>,
  layer = layerFor(bindAll(env.SECRETARY_EVAL_STANDARD_MODEL ?? "")),
): Promise<A> {
  const started = Date.now();
  const [value, stats] = await Effect.runPromise(
    Effect.provide(Effect.zip(effect, recordedCalls), layer),
  );
  console.log(`${label}: ${seconds(Date.now() - started)}, ${describeStats(stats)}`);
  return value;
}

type Outcome = {
  c: EvalCase;
  payloads: ProposalPayload[];
  errors: string[];
  /** The provider error that stopped the case, if any. */
  providerError: LlmErrorKind | null;
  pass: boolean;
  ms: number;
  stats: CallStats;
};

class StopRun extends Data.TaggedError("StopRun")<{ readonly message: string }> {}

/** One intake case in the current (fresh) database: directory, seeds, the turns, the score. */
const runCase = (c: EvalCase, label: string) =>
  Effect.gen(function* () {
    const started = Date.now();
    yield* (yield* Sync).run();
    const payments = yield* createTeam({
      name: "Payments",
      function: "Invoicing, ledger exports, refunds",
    });
    yield* createTeam({
      name: "Platform",
      function: "Shared infrastructure",
      contactFor: "Kubernetes, CI, incidents on shared services",
    });
    const network = yield* createTeam({ name: "Network", function: "Firewalls and routing" });
    const ana = yield* createPerson({
      displayName: "Ana Bell",
      jiraUsername: "ana.b",
      title: "Tech lead",
      teamId: payments,
    });
    const tom = yield* createPerson({
      displayName: "Tom Kay",
      jiraUsername: "tom.k",
      teamId: network,
    });
    const senders = { ana, tom };
    // Corrections the user made before (FR-7.2).
    const seeded = (c.corrections ?? []).map((x, i) => ({
      id: `eval-correction-${i}`,
      kind: "example" as const,
      subjectType: "proposal_kind",
      subjectId: String(x.before.kind),
      content: "Changed",
      exampleInput: x.input,
      exampleBefore: x.before,
      exampleAfter: x.after,
      source: "user" as const,
      confirmed: true,
      createdAt: "2026-09-20T09:00:00.000Z",
    }));
    if (seeded.length) yield* query((d) => d.insert(memories).values(seeded));
    // Small-ask cases run with a home (D44); every other case runs without one.
    if (c.home)
      yield* (yield* Settings).update((s) => ({
        ...s,
        smallAsks: { ...s.smallAsks, projectKey: EVAL_HOME },
      }));
    // The requester is a contact id made in this run, so the expectation gets it here.
    const withRequester: EvalCase = c.requester
      ? {
          ...c,
          expect: {
            ...c.expect,
            required: c.expect.required.map((r) =>
              r.kind === "create_issue"
                ? {
                    ...r,
                    fields: { ...r.fields, requesterPersonId: senders[c.requester ?? "ana"] },
                  }
                : r,
            ),
          },
        }
      : c;
    // A contact target (`contact:tom`) is the contact's id in this run.
    const scored: EvalCase = {
      ...withRequester,
      expect: {
        ...withRequester.expect,
        required: withRequester.expect.required.map((r) => {
          const who = r.target?.startsWith("contact:") ? r.target.slice(8) : null;
          return who === "ana" || who === "tom" ? { ...r, target: senders[who] } : r;
        }),
      },
    };
    // An open wait the text may answer (D46).
    if (c.wait)
      yield* createDependency({
        issueKey: c.wait.issueKey,
        kind: "person",
        label: c.wait.label,
        ownerPersonId: senders[c.wait.owner],
        expectedAt: c.wait.expectedAt ?? null,
      });
    // A provider error (timeout, rate limit) fails this case; the run decides whether to go on.
    const intake = yield* Intake;
    const attempt = yield* Effect.either(
      Effect.gen(function* () {
        const first = yield* intake.triage({
          text: c.text,
          instruction: c.instruction ?? null,
          source: c.source,
          senderPersonId: c.sender ? senders[c.sender] : null,
          // Fixed, so relative dates and the sprint calendar match the fixtures.
          today: TODAY,
        });
        // A thread's turns run in order inside the case.
        if (c.followUp)
          yield* intake.reply({
            inboxItemId: first.inboxItemId,
            instruction: c.followUp,
            today: TODAY,
          });
        if (c.followUpPaste)
          yield* intake.reply({
            inboxItemId: first.inboxItemId,
            text: c.followUpPaste,
            today: TODAY,
          });
        return first;
      }),
    );
    let payloads: ProposalPayload[] = [];
    let errors: string[] = [];
    let providerError: LlmErrorKind | null = null;
    if (attempt._tag === "Left") {
      const e = attempt.left;
      if (e._tag === "LlmError") providerError = e.kind;
      errors = [`${e._tag}${e._tag === "LlmError" ? ` ${e.kind}` : ""}: ${e.message}`];
    } else {
      // Scored on what the thread ends with: replaced proposals do not count.
      const id = attempt.right.inboxItemId;
      const rows = (yield* query((d) =>
        d
          .select()
          .from(proposals)
          .where(eq(proposals.inboxItemId, id))
          .orderBy(asc(proposals.seq))
          .all(),
      )).filter((x) => x.status !== "superseded");
      const items = yield* query((d) =>
        d.select().from(intakeItems).where(eq(intakeItems.inboxItemId, id)).all(),
      );
      payloads = rows.map((x) => x.payload as ProposalPayload);
      errors = items.map((i) => i.error).filter((e): e is string => !!e);
    }
    const stats = yield* recordedCalls;
    const ms = Date.now() - started;
    const pass = scoreCase(scored.expect, payloads).pass;
    // Progress, so a slow or interrupted run still shows what each case did.
    console.log(
      `${label}${pass ? "PASS" : "FAIL"}  ${seconds(ms).padStart(6)}  ${describeStats(stats)}  ${c.name}${providerError ? `  [${errors[0]?.slice(0, 160)}]` : ""}`,
    );
    return { c: scored, payloads, errors, providerError, pass, ms, stats } satisfies Outcome;
  });

/**
 * Every case in its own database and layer, `concurrency` at a time. Stops
 * early when the provider, not the model, is failing (see `stopReason`).
 */
const runCases = (cases: EvalCase[], model: string, label = "") =>
  Effect.gen(function* () {
    const finished: (LlmErrorKind | null)[] = [];
    return yield* Effect.forEach(
      cases,
      (c) =>
        runCase(c, label).pipe(
          Effect.provide(layerFor(bindAll(model))),
          Effect.tap((o) => {
            finished.push(o.providerError);
            const stop = stopReason(finished, cases.length);
            return stop
              ? Effect.fail(
                  new StopRun({ message: stopMessage(stop, finished.length, cases.length) }),
                )
              : Effect.void;
          }),
        ),
      { concurrency },
    );
  });

/** Runs the cases; a provider stop or a harness error fails the test with its message. */
async function runIntake(cases: EvalCase[], model: string, label = "") {
  const r = await Effect.runPromise(Effect.either(runCases(cases, model, label)));
  if (r._tag === "Right") return r.right;
  // Timeouts spent waiting out 429s are a provider without capacity, not a slow model.
  const turnedAway =
    r.left._tag === "StopRun" && rateLimitRetries > 0
      ? ` The provider turned requests away ${rateLimitRetries} times (429) during the run, so the time went on waiting for capacity: try again later or route elsewhere.`
      : "";
  const message = `${r.left.message}${turnedAway}`;
  console.log(`\n${message}\n  ${providerLine()}`);
  throw new Error(message);
}

/** Who answered (OpenRouter's `provider` field) and how many 429s the fetch waited out. */
const providerLine = () => {
  const served = [...upstream].map(([p, n]) => `${p} ${n}`).join(", ");
  return `responses served by: ${served || "(not reported)"}; 429s waited out: ${rateLimitRetries}`;
};

const report = (label: string, results: Outcome[]) => {
  console.log(`\n${label}`);
  for (const { c, payloads, errors, pass, ms, stats } of results) {
    const s = scoreCase(c.expect, payloads);
    if (!pass) {
      // Details for diagnosis: what was proposed, what was asked, what failed validation.
      for (const p of payloads) console.log(`      ${describePayload(p)}`);
      for (const e of errors) console.log(`      error: ${e.replace(/\n/g, " | ")}`);
    }
    console.log(
      `${pass ? "PASS" : "FAIL"}  ${seconds(ms).padStart(6)}  ${describeStats(stats)}  ${c.name}: ${signature(payloads) || "(nothing)"}${s.missing.length ? `  missing ${s.missing.map((m) => `${m.kind}:${m.target ?? "*"}`).join(", ")}` : ""}${s.forbidden.length ? `  forbidden ${s.forbidden.join(", ")}` : ""}`,
    );
  }
  return results.filter((r) => r.pass).length / results.length;
};

/** Wall time, model calls and tokens of the run, the slowest cases and who served them. */
const summary = (label: string, results: Outcome[], wallMs: number) => {
  const total = results.reduce((s, r) => addStats(s, r.stats), noCalls);
  const passed = results.filter((r) => r.pass).length;
  const slowest = [...results]
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 5)
    .map((r) => `${r.c.name} (${seconds(r.ms)})`);
  console.log(
    [
      `\n${label}: ${passed}/${results.length} passed, ${seconds(wallMs)} wall, concurrency ${concurrency}, effort ${effort}${pinned ? `, provider pinned to ${pinned}` : ""}`,
      `  model calls: ${describeStats(total)}; tokens: ${total.inputTokens} input, ${total.outputTokens} output`,
      `  slowest: ${slowest.join("; ")}`,
      `  ${providerLine()}`,
    ].join("\n"),
  );
};

describe.skipIf(!configured)("live intake eval", () => {
  test.concurrent("standard tier meets the pass rate", async () => {
    const model = env.SECRETARY_EVAL_STANDARD_MODEL ?? "";
    console.log(
      `intake: ${selected.length} cases on ${model}, ${concurrency} at a time, effort ${effort}${pinned ? `, provider ${pinned}` : ""}`,
    );
    const started = Date.now();
    const results = await runIntake(selected, model);
    const rate = report(`standard: ${model}`, results);
    summary(`standard: ${model}`, results, Date.now() - started);
    expect(rate).toBeGreaterThanOrEqual(PASS_RATE);
    // A slow model needs over a minute per case; follow-ups add a turn.
  }, 1_800_000);

  test.concurrent.skipIf(!env.SECRETARY_EVAL_FAST_MODEL)(
    "fast and standard agree on explicit single-item cases",
    async () => {
      const single = selected.filter((c) => c.single);
      const [fast, standard] = await Promise.all([
        runIntake(single, env.SECRETARY_EVAL_FAST_MODEL ?? "", "[fast] "),
        runIntake(single, env.SECRETARY_EVAL_STANDARD_MODEL ?? "", "[standard] "),
      ]);
      report("fast", fast);
      report("standard", standard);
      const disagreements = single.filter(
        (_, i) => signature(fast[i]?.payloads ?? []) !== signature(standard[i]?.payloads ?? []),
      );
      console.log(
        disagreements.length
          ? `Disagree on: ${disagreements.map((c) => c.name).join(", ")}`
          : "Tiers agree on every single-item case.",
      );
      expect(disagreements).toEqual([]);
    },
    900_000,
  );
});

describe.skipIf(!configured || !!env.SECRETARY_EVAL_CASE)("live drafting eval (Phase 6)", () => {
  test.concurrent("chases name the incident and first request date; opposite profiles read differently", async () => {
    const drafts = await runLive(
      "drafts",
      Effect.gen(function* () {
        yield* (yield* Sync).run();
        const platform = yield* createTeam({
          name: "Platform",
          function: "Shared infrastructure",
        });
        const contacts = {
          formal: yield* createPerson({
            displayName: "Priya Shah",
            title: "Head of SRE",
            teamId: platform,
            profile: { formality: "formal", detail: "detailed", responsiveness: "slow" },
          }),
          casual: yield* createPerson({
            displayName: "Sam Lee",
            title: "SRE",
            teamId: platform,
            profile: { formality: "casual", detail: "brief", responsiveness: "fast" },
          }),
        };
        const out: {
          who: string;
          ok: boolean;
          error?: string;
          short?: string;
          standard?: string;
        }[] = [];
        for (const [who, personId] of Object.entries(contacts)) {
          const dep = yield* createDependency({
            issueKey: "PAY-2",
            kind: "incident",
            label: "Platform ledger fix",
            ownerPersonId: personId,
            externalRef: "INC0012345",
            expectedAt: "2026-09-24",
          });
          // Asked a week and a half before the fixtures' today.
          yield* query((d) =>
            d
              .update(dependencies)
              .set({ requestedAt: "2026-09-15T09:00:00.000Z" })
              .where(eq(dependencies.id, dep)),
          );
          const id = yield* requestChaseDraft(dep);
          const r = yield* Effect.either((yield* Comms).generate(id, { today: TODAY }));
          const v = (yield* draftDetail(id))?.draft.variants;
          out.push(
            r._tag === "Left"
              ? {
                  who,
                  ok: false,
                  error: `${r.left.message} ${JSON.stringify((r.left as { issues?: unknown }).issues ?? [])}`,
                }
              : { who, ok: true, short: v?.short, standard: v?.standard },
          );
        }
        return out;
      }),
    );
    for (const d of drafts) {
      console.log(`\n${d.ok ? "PASS" : "FAIL"}  chase to the ${d.who} contact`);
      console.log(d.ok ? `  short: ${d.short}\n  standard: ${d.standard}` : `  ${d.error}`);
    }
    // Content checks (incident number, first request date) run in code before a draft is saved.
    expect(drafts.every((d) => d.ok)).toBe(true);
    const formal = drafts.find((d) => d.who === "formal")?.standard ?? "";
    const casual = drafts.find((d) => d.who === "casual")?.standard ?? "";
    expect(formal).not.toMatch(/^\s*hey\b/i);
    expect(casual).not.toMatch(/^\s*dear\b/i);
    expect(casual.length).toBeLessThan(formal.length);
  }, 600_000);
});

describe.skipIf(!configured || !!env.SECRETARY_EVAL_CASE)("live chat eval (Phase 7)", () => {
  test.concurrent("answers from local data and turns a change into a pending proposal", async () => {
    const ask = (text: string) =>
      Effect.gen(function* () {
        const stream = yield* (yield* Chat).stream({
          messages: [{ id: "u", role: "user", parts: [{ type: "text", text }] }],
        });
        const chunks = yield* Effect.promise(() => drainStream(stream));
        return {
          text: chunks.map((c) => (c.type === "text-delta" ? c.delta : "")).join(""),
          tools: chunks.flatMap((c) => (c.type === "tool-input-available" ? [c.toolName] : [])),
          errors: chunks.flatMap((c) => (c.type === "error" ? [c.errorText] : [])),
        };
      });
    const r = await runLive(
      "chat",
      Effect.gen(function* () {
        yield* (yield* Sync).run();
        const platform = yield* createTeam({
          name: "Platform",
          function: "Shared infrastructure",
        });
        yield* createDependency({
          issueKey: "PAY-2",
          kind: "incident",
          label: "Ledger fix",
          ownerTeamId: platform,
          externalRef: "INC0012345",
        });
        const waiting = yield* ask("What am I waiting on from team Platform?");
        const change = yield* ask("Comment on PAY-4 that we are blocked until finance signs off.");
        const pending = yield* query((d) =>
          d.select().from(proposals).where(eq(proposals.status, "pending")).all(),
        );
        return { waiting, change, pending };
      }),
    );
    console.log(`\nchat: waiting -> [${r.waiting.tools.join(", ")}] ${r.waiting.text}`);
    console.log(`chat: change -> [${r.change.tools.join(", ")}] ${r.change.text}`);
    expect(r.waiting.errors).toEqual([]);
    expect(r.waiting.tools).toContain("waiting_on");
    expect(r.waiting.text).toContain("INC0012345");
    expect(r.change.tools).toContain("propose_actions");
    expect(
      r.pending.some(
        (p) => p.kind === "add_comment" && (p.payload as { target?: string }).target === "PAY-4",
      ),
    ).toBe(true);
  }, 600_000);
});

describe.skipIf(!configured || !!env.SECRETARY_EVAL_CASE)("live planning eval (D30)", () => {
  test.concurrent("drafts a sprint plan that passes the checks", async () => {
    const r = await runLive(
      "planning",
      Effect.gen(function* () {
        yield* (yield* Sync).run();
        const set = (key: string, v: Partial<typeof jiraIssues.$inferInsert>) =>
          query((d) => d.update(jiraIssues).set(v).where(eq(jiraIssues.key, key)));
        yield* set("PAY-2", { assignee: "rliu", sprint: "Payments 15" });
        yield* set("PAY-3", {
          assignee: "rliu",
          resolved: "2026-09-10T10:00:00.000Z",
          storyPoints: 3,
        });
        yield* set("OPS-7", { assignee: null, epicKey: "PAY-1" });
        const state = parseSprintState(yield* getState(SYNC_KEYS.sprints));
        yield* setState(
          SYNC_KEYS.sprints,
          JSON.stringify({
            ...state,
            sprints: [
              ...state.sprints,
              {
                id: 43,
                name: "Payments 16",
                state: "future",
                boardId: 7,
                start: "2026-09-28",
                end: "2026-10-12",
              },
            ],
          }),
        );
        return yield* Effect.either(
          (yield* Planning).draft({
            capacity: 6,
            instructions: ["Friday is a release freeze"],
            today: TODAY,
          }),
        );
      }),
    );
    if (r._tag === "Right") {
      const p = r.right.plan;
      console.log(
        `\nplan: goal "${p.goal}"; picks ${p.picks.map((x) => `${x.key} (${x.reason})`).join(", ")}; deferred ${p.deferred.map((x) => x.key).join(", ") || "none"}; ${p.points} points; risks: ${p.risks.join(" | ")}`,
      );
    } else console.log(`\nplan failed: ${r.left.message}`);
    // The plan's checks (carry-over decided, capacity, blockers named) ran in code.
    expect(r._tag).toBe("Right");
  }, 600_000);
});

describe.skipIf(!configured || !!env.SECRETARY_EVAL_CASE)("live report eval (D39)", () => {
  test.concurrent("writes a talk track and ticket lines that pass the checks, in every style", async () => {
    const now = Date.now();
    const ago = (h: number) => new Date(now - h * 3_600_000).toISOString();
    const day = (d: number) => new Date(now + d * 86_400_000).toISOString().slice(0, 10);
    const history = (
      key: string,
      entries: { h: number; from: string; to: string }[],
    ): StubRoute => ({
      match: (u) =>
        u.pathname.endsWith(`/issue/${key}`) &&
        (u.searchParams.get("expand") ?? "").includes("changelog"),
      respond: () =>
        json({
          key,
          fields: {},
          changelog: {
            histories: entries.map((e, n) => ({
              id: String(n),
              author: { name: "rliu", displayName: "Rick Liu" },
              created: ago(e.h),
              items: [{ field: "status", fieldtype: "jira", fromString: e.from, toString: e.to }],
            })),
          },
        }),
    });
    const routes = [
      history("PAY-3", [{ h: 20, from: "In Review", to: "Done" }]),
      history("PAY-4", [{ h: 24, from: "In Progress", to: "In Review" }]),
    ];
    const r = await runLive(
      "report",
      Effect.gen(function* () {
        yield* (yield* Sync).run();
        const set = (key: string, v: Partial<typeof jiraIssues.$inferInsert>) =>
          query((d) => d.update(jiraIssues).set(v).where(eq(jiraIssues.key, key)));
        yield* set("PAY-3", {
          assignee: "rliu",
          isSubtask: false,
          issueType: "Story",
          status: "Done",
          statusCategory: "done",
          resolved: ago(20),
          updated: ago(18),
          storyPoints: 3,
          sprint: "Payments 15",
        });
        yield* set("PAY-4", {
          assignee: "rliu",
          status: "In Review",
          statusCategory: "indeterminate",
          updated: ago(22),
          storyPoints: 5,
          sprint: "Payments 15",
        });
        // PAY-2 is blocked by OPS-7 in the fixtures.
        yield* set("PAY-2", {
          assignee: "rliu",
          storyPoints: 3,
          sprint: "Payments 15",
          updated: ago(30),
        });
        const state = parseSprintState(yield* getState(SYNC_KEYS.sprints));
        yield* setState(
          SYNC_KEYS.sprints,
          JSON.stringify({
            ...state,
            sprints: [
              {
                id: 42,
                name: "Payments 15",
                state: "active",
                boardId: 7,
                start: day(-12),
                end: day(2),
              },
            ],
          }),
        );
        yield* query((d) =>
          d.insert(jiraComments).values([
            {
              id: "c-ana",
              issueKey: "PAY-3",
              author: "ana.b",
              authorDisplay: "Ana Bell",
              body: "Verified on staging, all four rounding cases pass. Can we ship this in the 1 October release?",
              created: ago(17),
              updated: ago(17),
            },
            {
              id: "c-tom",
              issueKey: "PAY-4",
              author: "tom.k",
              authorDisplay: "Tom Kay",
              body: "Export looks right. Excel users need UTF-8 with a BOM though, otherwise names with accents break. Can you add it?",
              created: ago(21),
              updated: ago(21),
            },
          ]),
        );
        const network = yield* createTeam({ name: "Network", function: "Firewalls" });
        const dep = yield* createDependency({
          issueKey: "PAY-2",
          kind: "incident",
          label: "Firewall rule for the bank endpoint",
          externalRef: "INC0012345",
          ownerTeamId: network,
          expectedAt: day(-2),
          status: "blocked",
        });
        yield* query((d) =>
          d
            .update(dependencies)
            .set({ requestedAt: ago(96), nextFollowupAt: day(0) })
            .where(eq(dependencies.id, dep)),
        );
        yield* query((d) =>
          d.insert(followups).values({
            id: "f1",
            dependencyId: dep,
            at: ago(26),
            channel: "teams",
            summary: "Asked Priya for an ETA; no reply yet",
          }),
        );
        return yield* (yield* Reports).generate({
          period: { kind: "days", days: 3 },
          scope: "mine",
        });
      }),
      layerFor(bindAll(env.SECRETARY_EVAL_STANDARD_MODEL ?? ""), routes),
    );
    for (const style of REPORT_STYLES)
      console.log(`\n===== ${style} =====\n${renderReport(r, style)}`);
    expect(r.talkTrack).toContain("PAY-3");
    expect(r.talkTrack).toContain("PAY-2");
    expect(r.tickets.find((t) => t.key === "PAY-4")?.happened).not.toBe("");
  }, 600_000);
});

describe.skipIf(!configured || !!env.SECRETARY_EVAL_CASE)("live vault chat eval (D41)", () => {
  test.concurrent("answers from the user's notes and names the note", async () => {
    const r = await runLive(
      "vault chat",
      Effect.gen(function* () {
        const stream = yield* (yield* Chat).stream({
          messages: [
            {
              id: "u",
              role: "user",
              parts: [
                {
                  type: "text",
                  text: "What did we decide about the ledger export, and who owns it?",
                },
              ],
            },
          ],
        });
        const chunks = yield* Effect.promise(() => drainStream(stream));
        return {
          text: chunks.map((c) => (c.type === "text-delta" ? c.delta : "")).join(""),
          tools: chunks.flatMap((c) => (c.type === "tool-input-available" ? [c.toolName] : [])),
        };
      }),
    );
    console.log(`\nvault chat: tools ${r.tools.join(", ")}\n${r.text}`);
    expect(r.tools).toContain("search_vault");
    expect(r.text).toMatch(/UTC/);
    expect(r.text).toMatch(/Dana/);
  }, 600_000);
});

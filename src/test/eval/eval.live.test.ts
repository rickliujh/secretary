/**
 * Live intake eval against a real model. Skipped unless configured:
 *
 *   SECRETARY_EVAL_KIND=anthropic            # or openai-compatible
 *   SECRETARY_EVAL_BASE_URL=https://api.anthropic.com/v1
 *   SECRETARY_EVAL_API_KEY=...
 *   SECRETARY_EVAL_STANDARD_MODEL=claude-sonnet-5
 *   SECRETARY_EVAL_FAST_MODEL=claude-haiku-4-5   # optional: also compares tiers
 *   SECRETARY_EVAL_CASE="status change"         # optional: run only cases whose name contains this
 *   bun test src/test/eval
 *
 * Jira is a stub over the fixtures, so nothing is written anywhere.
 */
import { describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { intakeItems, proposals } from "@/db/schema";
import { query } from "@/services/db";
import { DbTest } from "@/services/db/test";
import { createPerson, createTeam } from "@/services/directory/queries";
import { scoreCase, signature } from "@/services/eval/score";
import { makeFetcherTest } from "@/services/http";
import { Intake } from "@/services/intake";
import { IntakeLive } from "@/services/intake/live";
import { JiraClientLive } from "@/services/jira/live";
import { LlmLive, ModelFactoryLive } from "@/services/llm/live";
import { describePayload, type ProposalPayload } from "@/services/proposals/schema";
import { RetrievalLive } from "@/services/retrieval/live";
import { secretNames } from "@/services/secrets";
import { makeSecretsTest } from "@/services/secrets/test";
import { ProviderSchema, type TierBindings } from "@/services/settings/schema";
import { makeSettingsTest } from "@/services/settings/test";
import { Sync } from "@/services/sync";
import { SyncLive } from "@/services/sync/live";
import comments from "@/test/fixtures/jira/comments-PAY-2.json";
import fields from "@/test/fixtures/jira/field.json";
import myself from "@/test/fixtures/jira/myself.json";
import { jiraSettings } from "@/test/layers";
import { fixtureIssues } from "@/test/seed";
import { json, stubFetch } from "@/test/stub-fetch";
import { EVAL_CASES, type EvalCase } from "./cases";

const env = process.env;
const configured = !!(
  env.SECRETARY_EVAL_API_KEY &&
  env.SECRETARY_EVAL_BASE_URL &&
  env.SECRETARY_EVAL_STANDARD_MODEL
);
const PASS_RATE = 0.75;
const selected = env.SECRETARY_EVAL_CASE
  ? EVAL_CASES.filter((c) => c.name.includes(env.SECRETARY_EVAL_CASE ?? ""))
  : EVAL_CASES;

function layerFor(tiers: TierBindings) {
  const provider = ProviderSchema.parse({
    id: "eval",
    name: "Eval",
    kind: env.SECRETARY_EVAL_KIND === "openai-compatible" ? "openai-compatible" : "anthropic",
    baseUrl: env.SECRETARY_EVAL_BASE_URL,
  });
  const jiraStub = stubFetch([
    { match: (u) => u.pathname.endsWith("/myself"), respond: () => json(myself) },
    { match: (u) => u.pathname.endsWith("/field"), respond: () => json(fields) },
    { match: (u) => u.pathname.endsWith("/comment"), respond: () => json(comments) },
    // Project metadata as a real sync reads it (every issue type and status per project).
    {
      match: (u) => /\/project\/[A-Z]+\/statuses$/.test(u.pathname),
      respond: (r) => {
        const pay = r.url.pathname.includes("/PAY/");
        const statuses = (names: string[]) => names.map((name) => ({ name }));
        return json(
          pay
            ? ["Epic", "Story", "Task", "Bug", "Sub-task"].map((name) => ({
                name,
                statuses: statuses(["To Do", "In Progress", "Blocked", "In Review", "Done"]),
              }))
            : ["Task", "Sub-task"].map((name) => ({
                name,
                statuses: statuses(["To Do", "In Progress", "Done"]),
              })),
        );
      },
    },
    {
      match: (u) => u.pathname.endsWith("/search"),
      respond: (r) => {
        const b = r.body as { startAt: number; jql: string };
        const src = b.jql.startsWith("(parent in") ? [] : fixtureIssues;
        return json({
          startAt: b.startAt,
          maxResults: 100,
          total: src.length,
          issues: src.slice(b.startAt),
        });
      },
    },
  ]);
  // Jira goes to the stub; the model provider gets real network access.
  const fetcher = makeFetcherTest((input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    return url.startsWith("https://jira.example.com")
      ? jiraStub.fetch(input, init)
      : fetch(input, init);
  });
  const base = Layer.mergeAll(
    makeSettingsTest({
      ...jiraSettings({ trackedEpics: ["PAY-1"] }),
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
  return Layer.provideMerge(IntakeLive, Layer.provideMerge(RetrievalLive, withLlm));
}

const runCases = (cases: EvalCase[]) =>
  Effect.gen(function* () {
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
    const out: { c: EvalCase; payloads: ProposalPayload[]; errors: string[] }[] = [];
    for (const c of cases) {
      // A provider error (timeout, rate limit) fails this case, not the whole run.
      const attempt = yield* Effect.either(
        (yield* Intake).triage({
          text: c.text,
          source: c.source,
          senderPersonId: c.sender ? senders[c.sender] : null,
        }),
      );
      if (attempt._tag === "Left") {
        const e = attempt.left;
        out.push({ c, payloads: [], errors: [`${e._tag}: ${e.message}`] });
        continue;
      }
      const r = attempt.right;
      const rows = yield* query((d) =>
        d
          .select()
          .from(proposals)
          .where(eq(proposals.inboxItemId, r.inboxItemId))
          .orderBy(asc(proposals.seq))
          .all(),
      );
      const items = yield* query((d) =>
        d.select().from(intakeItems).where(eq(intakeItems.inboxItemId, r.inboxItemId)).all(),
      );
      out.push({
        c,
        payloads: rows.map((x) => x.payload as ProposalPayload),
        errors: items.map((i) => i.error).filter((e): e is string => !!e),
      });
    }
    return out;
  });

const report = (
  label: string,
  results: { c: EvalCase; payloads: ProposalPayload[]; errors?: string[] }[],
) => {
  let passed = 0;
  console.log(`\n${label}`);
  for (const { c, payloads } of results) {
    const s = scoreCase(c.expect, payloads);
    if (s.pass) passed++;
    else {
      // Details for diagnosis: what was proposed, what was asked, what failed validation.
      for (const p of payloads) console.log(`      ${describePayload(p)}`);
      for (const e of results.find((x) => x.c === c)?.errors ?? [])
        console.log(`      validation: ${e.replace(/\n/g, " | ")}`);
    }
    console.log(
      `${s.pass ? "PASS" : "FAIL"}  ${c.name}: ${signature(payloads) || "(nothing)"}${s.missing.length ? `  missing ${s.missing.map((m) => `${m.kind}:${m.target ?? "*"}`).join(", ")}` : ""}${s.forbidden.length ? `  forbidden ${s.forbidden.join(", ")}` : ""}`,
    );
  }
  return passed / results.length;
};

describe.skipIf(!configured)("live intake eval", () => {
  test("standard tier meets the pass rate", async () => {
    const model = env.SECRETARY_EVAL_STANDARD_MODEL ?? "";
    const bind = { providerId: "eval", model };
    const results = await Effect.runPromise(
      Effect.provide(runCases(selected), layerFor({ fast: bind, standard: bind, strong: null })),
    );
    expect(report(`standard: ${model}`, results)).toBeGreaterThanOrEqual(PASS_RATE);
  }, 600_000);

  test.skipIf(!env.SECRETARY_EVAL_FAST_MODEL)(
    "fast and standard agree on explicit single-item cases",
    async () => {
      const single = selected.filter((c) => c.single);
      const run = (model: string) => {
        const bind = { providerId: "eval", model };
        return Effect.runPromise(
          Effect.provide(runCases(single), layerFor({ fast: bind, standard: bind, strong: null })),
        );
      };
      const fast = await run(env.SECRETARY_EVAL_FAST_MODEL ?? "");
      const standard = await run(env.SECRETARY_EVAL_STANDARD_MODEL ?? "");
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

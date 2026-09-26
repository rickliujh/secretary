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
import type { UIMessageChunk } from "ai";
import { asc, eq, inArray } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { dependencies, intakeItems, memories, proposals } from "@/db/schema";
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
import { LlmLive, ModelFactoryLive } from "@/services/llm/live";
import { describePayload, type ProposalPayload } from "@/services/proposals/schema";
import { RetrievalLive } from "@/services/retrieval/live";
import { secretNames } from "@/services/secrets";
import { makeSecretsTest } from "@/services/secrets/test";
import { ProviderSchema, type TierBindings } from "@/services/settings/schema";
import { makeSettingsTest } from "@/services/settings/test";
import { Sync } from "@/services/sync";
import { SyncLive } from "@/services/sync/live";
import boardSprints from "@/test/fixtures/jira/board-7-sprints.json";
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
/** The fixtures' "today": Payments 15 is the active sprint (2026-09-14 to 2026-09-28). */
const EVAL_TODAY = "2026-09-24";

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
    {
      match: (u) => u.pathname.endsWith("/rest/agile/1.0/board/7/sprint"),
      respond: () => json(boardSprints),
    },
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
  const withConfluence = Layer.provideMerge(ConfluenceClientLive, withLlm);
  return Layer.provideMerge(
    ChatLive,
    Layer.provideMerge(
      CommsLive,
      Layer.provideMerge(IntakeLive, Layer.provideMerge(RetrievalLive, withConfluence)),
    ),
  );
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
      // Corrections exist only while their case runs, so other cases stay unaffected.
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
      // A provider error (timeout, rate limit) fails this case, not the whole run.
      const intake = yield* Intake;
      const attempt = yield* Effect.either(
        Effect.gen(function* () {
          const first = yield* intake.triage({
            text: c.text,
            instruction: c.instruction ?? null,
            source: c.source,
            senderPersonId: c.sender ? senders[c.sender] : null,
            // Fixed, so relative dates and the sprint calendar match the fixtures.
            today: EVAL_TODAY,
          });
          if (c.followUp)
            yield* intake.reply({
              inboxItemId: first.inboxItemId,
              instruction: c.followUp,
              today: EVAL_TODAY,
            });
          return first;
        }),
      );
      if (seeded.length)
        yield* query((d) =>
          d.delete(memories).where(
            inArray(
              memories.id,
              seeded.map((x) => x.id),
            ),
          ),
        );
      if (attempt._tag === "Left") {
        const e = attempt.left;
        out.push({ c, payloads: [], errors: [`${e._tag}: ${e.message}`] });
        console.log(`  error ${c.name}: ${e.message.slice(0, 200)}`);
        continue;
      }
      const r = attempt.right;
      // Scored on what the thread ends with: replaced proposals do not count.
      const rows = (yield* query((d) =>
        d
          .select()
          .from(proposals)
          .where(eq(proposals.inboxItemId, r.inboxItemId))
          .orderBy(asc(proposals.seq))
          .all(),
      )).filter((x) => x.status !== "superseded");
      const items = yield* query((d) =>
        d.select().from(intakeItems).where(eq(intakeItems.inboxItemId, r.inboxItemId)).all(),
      );
      const payloads = rows.map((x) => x.payload as ProposalPayload);
      out.push({ c, payloads, errors: items.map((i) => i.error).filter((e): e is string => !!e) });
      // Progress, so a slow or interrupted run still shows what each case did.
      console.log(`  done  ${c.name}: ${signature(payloads) || "(nothing)"}`);
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
    // Slow models need well over a minute per case; follow-ups add a turn.
  }, 1_800_000);

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

describe.skipIf(!configured || !!env.SECRETARY_EVAL_CASE)("live drafting eval (Phase 6)", () => {
  test("chases name the incident and first request date; opposite profiles read differently", async () => {
    const model = env.SECRETARY_EVAL_STANDARD_MODEL ?? "";
    const bind = { providerId: "eval", model };
    const drafts = await Effect.runPromise(
      Effect.provide(
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
            const r = yield* Effect.either((yield* Comms).generate(id, { today: EVAL_TODAY }));
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
        layerFor({ fast: bind, standard: bind, strong: null }),
      ),
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
  test("answers from local data and turns a change into a pending proposal", async () => {
    const model = env.SECRETARY_EVAL_STANDARD_MODEL ?? "";
    const bind = { providerId: "eval", model };
    const ask = (text: string) =>
      Effect.gen(function* () {
        const stream = yield* (yield* Chat).stream({
          messages: [{ id: "u", role: "user", parts: [{ type: "text", text }] }],
        });
        const chunks: UIMessageChunk[] = [];
        const reader = stream.getReader();
        for (;;) {
          const r = yield* Effect.promise(() => reader.read());
          if (r.done) break;
          chunks.push(r.value);
        }
        return {
          text: chunks.map((c) => (c.type === "text-delta" ? c.delta : "")).join(""),
          tools: chunks.flatMap((c) => (c.type === "tool-input-available" ? [c.toolName] : [])),
          errors: chunks.flatMap((c) => (c.type === "error" ? [c.errorText] : [])),
        };
      });
    const r = await Effect.runPromise(
      Effect.provide(
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
          const change = yield* ask(
            "Comment on PAY-4 that we are blocked until finance signs off.",
          );
          const pending = yield* query((d) =>
            d.select().from(proposals).where(eq(proposals.status, "pending")).all(),
          );
          return { waiting, change, pending };
        }),
        layerFor({ fast: bind, standard: bind, strong: null }),
      ),
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

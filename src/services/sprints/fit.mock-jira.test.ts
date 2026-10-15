/**
 * FR-16 acceptance over real HTTP (Phase 20 checklist): with three working days
 * left in the user's sprint, two open 1-point tickets of theirs and 1 point =
 * 0.5 days, a new 2-point ticket "fits" (2 of 3 days); with a third open
 * 3-point ticket it is "over" (3.5 of 3 days). Its switch on adds it to that
 * sprint on approval, and the choice survives a re-triage; off leaves it in the
 * backlog. Real Intake, Retrieval, Sync, Executor and Proposals against
 * scripts/mock-jira.ts; only the model is scripted.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { ExecutorLive } from "@/services/executor/live";
import { inboxDetail } from "@/services/inbox/queries";
import { Intake } from "@/services/intake";
import { IntakeLive } from "@/services/intake/live";
import { LlmLive } from "@/services/llm/live";
import { makeScriptedModels } from "@/services/llm/test";
import { Proposals } from "@/services/proposals";
import { ProposalsLive } from "@/services/proposals/live";
import { CreateIssue, type PayloadOf } from "@/services/proposals/schema";
import { RetrievalLive } from "@/services/retrieval/live";
import { Sync } from "@/services/sync";
import { SyncLive } from "@/services/sync/live";
import { testProvider } from "@/test/helpers";
import { out } from "@/test/intake-layer";
import { jiraSettings, jiraTestLayer } from "@/test/layers";
import { boardSprints, createHandler, generate } from "../../../scripts/mock-jira";
import { lastSprintDay, workingDaysBetween } from "./fit";
import { threadSprintFits, userSprintLoad } from "./fit-query";

const servers: { stop: (force?: boolean) => void }[] = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

const DAY = 86_400_000;
const active = boardSprints(1).find((s) => s.state === "active");
if (!active) throw new Error("fixture: no active sprint");
// The sprint ends Monday 17:00 UTC; whether that day counts depends on the local
// time of day (D57), so step back from the last counted day to leave three.
const last = lastSprintDay({
  start: active.startDate.slice(0, 10),
  end: active.endDate.slice(0, 10),
  endAt: active.endDate,
});
const today = (() => {
  let ms = Date.parse(`${last}T00:00:00Z`);
  while (workingDaysBetween(new Date(ms).toISOString().slice(0, 10), last ?? "") < 3) ms -= DAY;
  return new Date(ms).toISOString().slice(0, 10);
})();

const create = {
  kind: "create_issue",
  ref: "$new:1",
  projectKey: "PAY",
  issueType: "Story",
  summary: "Export credit notes to the ledger",
  storyPoints: "2",
  pointsSource: "stated",
  rationale: "From the input",
  evidence: "2-pointer",
  confidence: 0.9,
};
const answer = { summary: "s", question: null, confidence: 0.9, proposals: [create] };
const TEXT = "We need a story to export credit notes to the ledger. It's a 2-pointer.";

/** Two open 1-point tickets of the user's in the PAY sprint (plus a 3-pointer when asked); nothing else is theirs. */
function setup(opts: { third?: boolean } = {}) {
  const issues = generate(80);
  const all = [...issues.values()];
  const me = all.find((i) => i.assignee?.name === "me")?.assignee;
  const ana = all.find((i) => i.assignee?.name === "ana.b")?.assignee;
  if (!me || !ana || !active) throw new Error("fixture: users");
  for (const i of all) if (i.assignee?.name === "me") i.assignee = ana;
  const open = all.filter((i) => i.project === "PAY" && (i.type === "Story" || i.type === "Task"));
  const mine = open.slice(0, opts.third ? 3 : 2);
  mine.forEach((i, n) => {
    i.assignee = me;
    i.status = "To Do";
    i.points = n === 2 ? 3 : 1;
    i.movedToSprint = active.id;
    i.inBacklog = false;
  });
  const server = Bun.serve({ port: 0, fetch: createHandler(issues) });
  servers.push(server);
  const base = jiraTestLayer((input, init) => fetch(input, init), {
    ...jiraSettings({ baseUrl: `http://localhost:${server.port}`, trackedEpics: [] }),
    providers: [testProvider],
    tiers: { fast: null, standard: { providerId: "p1", model: "std-m" }, strong: null },
    sprint: { daysPerPoint: 0.5, lastDay: "jira" },
  });
  const models = makeScriptedModels({ "std-m": [out(answer), out(answer)] });
  const llm = Layer.provideMerge(
    LlmLive,
    Layer.merge(Layer.provideMerge(SyncLive, base), models.layer),
  );
  const layer = Layer.provideMerge(
    Layer.merge(IntakeLive, ProposalsLive),
    Layer.provideMerge(Layer.merge(RetrievalLive, ExecutorLive), llm),
  );
  return { issues, layer };
}

/** Syncs, pastes the ask and reads the create's card fit. */
const pasteAndFit = Effect.gen(function* () {
  yield* (yield* Sync).run();
  const turn = yield* (yield* Intake).triage({
    text: TEXT,
    source: "teams",
    senderPersonId: null,
    today,
  });
  const rows = (yield* inboxDetail(turn.inboxItemId))?.proposals ?? [];
  const row = rows.find((r) => r.kind === "create_issue");
  if (!row) throw new Error("no create");
  const fits = yield* threadSprintFits(turn.inboxItemId, today);
  return { inboxItemId: turn.inboxItemId, row, fit: fits[row.id] };
});

describe("new tickets and the sprint against the mock Jira (FR-16 AC)", () => {
  test("a 2-pointer fits: 2 of 3 days", async () => {
    const { layer } = setup();
    const r = await Effect.runPromise(Effect.provide(pasteAndFit, layer));
    expect(r.fit?.kind).toBe("sprint");
    if (r.fit?.kind !== "sprint") return;
    expect(r.fit.sprint).toMatchObject({ name: active.name, daysLeft: 3 });
    expect(r.fit.sprint.when).toMatch(/^ends Mon \d+ \w+, 3 working days left$/);
    expect(r.fit.offBoard).toBe(false);
    expect(r.fit.fit).toMatchObject({ verdict: "fits", days: 2, points: 4 });
    expect(r.fit.fit.headline).toBe("Fits: about 2 of 3 working days");
    expect(r.fit.fit.details[0]).toBe("Your open tickets there: 2, 2 points, about 1 day");
    expect(r.fit.fit.details.at(-1)).toBe("1 point is about 0.5 days, from Settings");
  });

  test("with a third open 3-point ticket it is over: 3.5 of 3 days", async () => {
    const { layer } = setup({ third: true });
    const r = await Effect.runPromise(Effect.provide(pasteAndFit, layer));
    if (r.fit?.kind !== "sprint") throw new Error("no sprint");
    expect(r.fit.fit).toMatchObject({ verdict: "over", days: 3.5 });
    expect(r.fit.fit.headline).toBe("Over: about 3.5 of 3 working days");
  });

  test("switched on, the choice survives a re-triage and approval adds it to the sprint", async () => {
    const { issues, layer } = setup();
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const { inboxItemId, row } = yield* pasteAndFit;
          // No due date: off by default.
          expect(row.payload).toMatchObject({ joinSprint: false, joinSprintChosen: false });
          const svc = yield* Proposals;
          const on = CreateIssue.parse({
            ...row.payload,
            joinSprint: true,
            joinSprintChosen: true,
          });
          yield* svc.saveEdit(row.id, on);
          yield* (yield* Intake).retriage(inboxItemId);
          const rows = (yield* inboxDetail(inboxItemId))?.proposals ?? [];
          const fresh = rows.find((p) => p.kind === "create_issue" && p.status === "pending");
          if (!fresh) throw new Error("no revised create");
          const load = yield* userSprintLoad(today);
          return { fresh, load, result: yield* svc.approve(fresh.id) };
        }),
        layer,
      ),
    );
    const payload = r.fresh.payload as PayloadOf<"create_issue">;
    expect(payload).toMatchObject({ joinSprint: true, joinSprintChosen: true });
    // Today's header: the load alone.
    expect(r.load.fit).toMatchObject({ verdict: "fits", days: 1 });
    expect(r.result.status).toBe("executed");
    expect(r.result.message).toBe(`Created ${r.result.issueKey} in sprint ${active.name}`);
    expect(issues.get(r.result.issueKey ?? "")?.movedToSprint).toBe(active.id);
  });

  test("switched off, approval leaves it in the backlog", async () => {
    const { issues, layer } = setup();
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const { row } = yield* pasteAndFit;
          return yield* (yield* Proposals).approve(row.id);
        }),
        layer,
      ),
    );
    expect(r.status).toBe("executed");
    expect(r.message).toBe(`Created ${r.issueKey}`);
    const created = issues.get(r.issueKey ?? "");
    expect(created?.movedToSprint).toBeUndefined();
    expect(created?.inBacklog).toBe(true);
  });
});

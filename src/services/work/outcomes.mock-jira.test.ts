/**
 * FR-19.6 acceptance (Phase 25) over real HTTP against scripts/mock-jira.ts:
 * real Sync, Intake, Proposals and Executor; only the model is scripted.
 *
 * - PAY-12 waits on Platform for the cert, expected two days ago, and Dana was
 *   promised an ETA. A paste moves the date: after the pass one card holds the
 *   wait update, the due-date update and the ETA draft.
 * - Approving with the draft left out runs the two steps in order (the due date
 *   lands on the mock) and records one correction.
 * - A sync that turns PLAT-812 Done gives a `blocker_closed` card whose
 *   approval moves PAY-12 out of Blocked and comments on it.
 * - Dismissing a `wait_unanswered` card twice on the item makes the third run
 *   offer nothing there.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import {
  actionsLog,
  dependencies,
  inboxItems,
  issueMeta,
  memories,
  people,
  proposals,
  teams,
  workItemIssues,
  workItems,
} from "@/db/schema";
import { localDate } from "@/lib/dates";
import { loadToday } from "@/services/dashboard/data";
import { query } from "@/services/db";
import { ExecutorLive } from "@/services/executor/live";
import { Intake } from "@/services/intake";
import { IntakeLive } from "@/services/intake/live";
import { LlmLive } from "@/services/llm/live";
import { makeScriptedModels } from "@/services/llm/test";
import { Proposals } from "@/services/proposals";
import { ProposalsLive } from "@/services/proposals/live";
import { RetrievalLive } from "@/services/retrieval/live";
import { Sync } from "@/services/sync";
import { SyncLive } from "@/services/sync/live";
import { testProvider } from "@/test/helpers";
import { out } from "@/test/intake-layer";
import { jiraSettings, jiraTestLayer } from "@/test/layers";
import { createHandler, generate } from "../../../scripts/mock-jira";
import { runWorkPass } from "./pass";
import { situationOf, type WorkState } from "./schema";

const servers: { stop: (force?: boolean) => void }[] = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

const NOW = Date.now();
const day = (n: number) => localDate(new Date(NOW + n * 86_400_000));
/** "Expected 17 Oct", "moves to 24 Oct", relative to the day the test runs. */
const OLD = day(-2);
const NEW = day(5);
const jiraNow = () => new Date().toISOString().replace("Z", "+0000");

const ETA = "an ETA for the cert";
const commitment = (saidIn: string) => ({
  what: ETA,
  toPersonId: "c-dana",
  toName: null,
  dueOn: null,
  saidIn,
  status: "open" as const,
});
const stateOut = (patch: Record<string, unknown> = {}) => ({
  goal: "Renew the payment cert",
  currentStep: "Waiting on Platform for the cert",
  nextExpectedWhat: "Platform issues the cert",
  nextExpectedOn: NEW,
  commitments: [{ ...commitment("p1"), toName: null }],
  openQuestions: [],
  people: [],
  question: null,
  choices: [],
  ...patch,
});

function setup() {
  const issues = generate(40);
  const all = [...issues.values()];
  const me = all.find((i) => i.assignee?.name === "me")?.assignee;
  const ana = all.find((i) => i.assignee?.name === "ana.b")?.assignee;
  if (!me || !ana) throw new Error("fixture: users");
  for (const i of all) if (i.assignee?.name === "me") i.assignee = ana;
  const pay = issues.get("PAY-12");
  if (!pay) throw new Error("fixture: PAY-12");
  Object.assign(pay, {
    type: "Story",
    summary: "Renew the payment gateway cert",
    status: "Blocked",
    assignee: me,
    epic: null,
    parent: null,
    due: day(1),
    links: [{ type: "Blocks", inward: "PLAT-812" }],
    updated: jiraNow(),
  });
  issues.set("PLAT-812", {
    ...pay,
    id: "29999",
    key: "PLAT-812",
    project: "PLAT",
    summary: "Issue the new gateway cert",
    status: "In Progress",
    assignee: ana,
    links: [],
    comments: [],
    due: null,
  });
  const server = Bun.serve({ port: 0, fetch: createHandler(issues) });
  servers.push(server);
  const base = jiraTestLayer((input, init) => fetch(input, init), {
    ...jiraSettings({ baseUrl: `http://localhost:${server.port}`, trackedEpics: [] }),
    providers: [testProvider],
    tiers: {
      fast: { providerId: "p1", model: "fast-m" },
      standard: { providerId: "p1", model: "std-m" },
      strong: null,
    },
  });
  const models = makeScriptedModels({
    "std-m": [
      // The paste: nothing for classify to do but note it.
      out({
        summary: "Platform moved the cert date",
        question: null,
        confidence: 0.9,
        proposals: [],
      }),
      // The state moves the next date; the promise to Dana stands.
      out(stateOut()),
      // Later passes keep it.
      out(stateOut({ currentStep: "PLAT-812 is done: install the cert" })),
      out(stateOut({ currentStep: "Installing the cert" })),
      out(stateOut({ currentStep: "Installing the cert" })),
      out(stateOut({ currentStep: "Installing the cert" })),
    ],
  });
  const llm = Layer.provideMerge(
    LlmLive,
    Layer.merge(Layer.provideMerge(SyncLive, base), models.layer),
  );
  const layer = Layer.provideMerge(
    Layer.merge(IntakeLive, ProposalsLive),
    Layer.provideMerge(Layer.merge(RetrievalLive, ExecutorLive), llm),
  );
  return { layer, issues };
}

const secretaryCards = (rule?: string) =>
  Effect.map(
    query((d) =>
      d
        .select()
        .from(inboxItems)
        .where(eq(inboxItems.source, "secretary"))
        .orderBy(asc(inboxItems.receivedAt))
        .all(),
    ),
    (rows) => rows.filter((r) => !rule || situationOf(r.triage)?.rule === rule),
  );
const stepsOf = (id: string) =>
  query((d) =>
    d.select().from(proposals).where(eq(proposals.bundleId, id)).orderBy(asc(proposals.seq)).all(),
  );

describe("outcome cards against the mock Jira (FR-19.6 AC, Phase 25)", () => {
  test("a moved date, a closed blocker and a chase dismissed twice", async () => {
    const { layer, issues } = setup();
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sync = yield* Sync;
          const intake = yield* Intake;
          const svc = yield* Proposals;
          yield* sync.run();
          yield* query((d) => d.insert(people).values({ id: "c-dana", displayName: "Dana Lee" }));
          yield* query((d) => d.insert(teams).values({ id: "t-platform", name: "Platform" }));
          // Dana asked for the cert work, so she is one of the item's people.
          yield* query((d) =>
            d
              .insert(issueMeta)
              .values({ issueKey: "PAY-12", requesterPersonId: "c-dana" })
              .onConflictDoUpdate({
                target: issueMeta.issueKey,
                set: { requesterPersonId: "c-dana" },
              }),
          );
          yield* query((d) =>
            d.insert(dependencies).values({
              id: "w-plat",
              issueKey: "PAY-12",
              kind: "team",
              label: "the new gateway cert",
              ownerTeamId: "t-platform",
              externalRef: "PLAT-812",
              status: "waiting",
              requestedAt: new Date(NOW - 7 * 86_400_000).toISOString(),
              expectedAt: OLD,
            }),
          );

          // The item, and the secretary's record: expected OLD, Dana promised an ETA.
          yield* runWorkPass();
          const item =
            (yield* query((d) =>
              d.select().from(workItemIssues).where(eq(workItemIssues.issueKey, "PAY-12")).get(),
            ))?.workItemId ?? "";
          const before: WorkState = {
            goal: "Renew the payment cert",
            currentStep: "Waiting on Platform for the cert",
            nextExpected: { what: "Platform issues the cert", on: OLD },
            commitments: [commitment("e-earlier")],
            openQuestions: [],
            people: [],
          };
          yield* query((d) =>
            d.update(workItems).set({ state: before }).where(eq(workItems.id, item)),
          );
          const quiet = yield* runWorkPass();

          // 1. A paste moves the date.
          yield* intake.triage({
            text: `PAY-12: Platform now expects the cert on ${NEW}`,
            source: "teams",
            senderPersonId: null,
          });
          const moved = yield* runWorkPass();
          const [card] = yield* secretaryCards("expected_date_moved");
          const steps = yield* stepsOf(card?.id ?? "");
          const today = yield* loadToday();

          // 2. Approve with the draft left out.
          const kept = steps.filter((p) => p.kind !== "draft_message").map((p) => p.id);
          const results = yield* svc.approveBundle(card?.id ?? "", kept);
          const log = yield* query((d) =>
            d.select().from(actionsLog).orderBy(asc(actionsLog.at), asc(actionsLog.id)).all(),
          );
          const corrections = yield* query((d) =>
            d.select().from(memories).where(eq(memories.subjectType, "work_item")).all(),
          );
          const waitAfter = yield* query((d) =>
            d.select().from(dependencies).where(eq(dependencies.id, "w-plat")).get(),
          );
          const afterMove = yield* runWorkPass();

          // 3. PLAT-812 is done in Jira.
          const blocker = issues.get("PLAT-812");
          if (blocker) Object.assign(blocker, { status: "Done", updated: jiraNow() });
          yield* sync.run();
          const closed = yield* runWorkPass();
          const [resume] = yield* secretaryCards("blocker_closed");
          const resumeSteps = yield* stepsOf(resume?.id ?? "");
          const resumed = yield* svc.approveBundle(
            resume?.id ?? "",
            resumeSteps.map((p) => p.id),
          );

          // 4. A chase nobody answered, dismissed twice.
          yield* query((d) =>
            d.insert(dependencies).values({
              id: "w-chase",
              issueKey: "PAY-12",
              kind: "team",
              label: "the load balancer slot",
              ownerTeamId: "t-platform",
              status: "waiting",
              requestedAt: new Date(NOW - 10 * 86_400_000).toISOString(),
              nextFollowupAt: day(-1),
            }),
          );
          const chases: number[] = [];
          for (const due of [day(-1), day(-2), day(-3)]) {
            yield* query((d) =>
              d
                .update(dependencies)
                .set({ nextFollowupAt: due })
                .where(eq(dependencies.id, "w-chase")),
            );
            chases.push((yield* runWorkPass()).offered);
            const open = (yield* secretaryCards("wait_unanswered")).filter(
              (c) => c.status === "triaged",
            );
            for (const c of open) yield* svc.dismiss(c.id);
          }
          return {
            item,
            quiet,
            moved,
            card,
            steps,
            today,
            results,
            log,
            corrections,
            waitAfter,
            afterMove,
            closed,
            resume,
            resumeSteps,
            resumed,
            chases,
            chaseCards: yield* secretaryCards("wait_unanswered"),
            pay: issues.get("PAY-12"),
          };
        }),
        layer,
      ),
    );

    // Nothing before the date moved.
    expect(r.quiet.offered).toBe(0);

    // 1. One card: the wait, the due date before the new one, the ETA for Dana.
    expect(r.moved.offered).toBe(1);
    expect(r.card?.workItemId).toBe(r.item);
    expect(r.steps.map((p) => p.kind)).toEqual([
      "update_dependency",
      "update_issue",
      "draft_message",
    ]);
    expect(r.steps[0]?.payload).toMatchObject({ dependencyId: "w-plat", expectedAt: NEW });
    expect(r.steps[1]?.payload).toMatchObject({ target: "PAY-12", changes: { dueDate: NEW } });
    expect(r.steps[2]?.payload).toMatchObject({ recipientPersonId: "c-dana" });
    // Today: the card in Your move, and no plain wait row for PAY-12 beside it.
    expect(r.today.yourMove.some((x) => x.kind === "outcome" && x.outcome.id === r.card?.id)).toBe(
      true,
    );
    expect(
      r.today.theirMove.some((x) => x.kind === "wait" && x.dependency.issueKey === "PAY-12"),
    ).toBe(false);

    // 2. Two steps ran, in order; the draft left out is one correction.
    expect(r.results.map((x) => x.status)).toEqual(["executed", "executed"]);
    expect(r.log.map((l) => l.action)).toEqual(["update_dependency", "update_fields"]);
    expect(r.waitAfter?.expectedAt).toBe(NEW);
    expect(r.corrections).toHaveLength(1);
    expect(r.corrections[0]?.exampleAfter).toMatchObject({
      type: "step_left_out",
      rule: "expected_date_moved",
      kind: "draft_message",
    });
    // The wait moving to the same date is the same situation: no second card.
    expect(r.afterMove.offered).toBe(0);

    // 3. PLAT-812 done: resume PAY-12, say so, resolve the wait on it.
    expect(r.closed.offered).toBe(1);
    expect(r.resumeSteps.map((p) => p.kind)).toEqual([
      "transition_issue",
      "add_comment",
      "update_dependency",
    ]);
    expect(r.resumed.map((x) => x.status)).toEqual(["executed", "executed", "executed"]);
    expect(r.pay?.status).toBe("In Progress");
    expect(r.pay?.due).toBe(NEW);
    expect(r.pay?.comments.at(-1)?.body).toContain("PLAT-812 is done; picking this up again.");

    // 4. Two chase cards dismissed; the third run offers nothing on the item. The new
    // wait gets no "waiting on someone" card beside its chase (Phase 26): the chase
    // drafts and comments, and Platform has no Jira project to search.
    expect(r.chases).toEqual([1, 1, 0]);
    expect(r.chaseCards).toHaveLength(2);
    expect(r.chaseCards.every((c) => c.status === "dismissed")).toBe(true);
  }, 30_000);
});

/**
 * FR-19 acceptance, Phase 23 part, over real HTTP against scripts/mock-jira.ts:
 * real Sync, Intake, Retrieval, Executor and Proposals; only the model is
 * scripted.
 *
 * - PAY-12, the user's ticket in the active sprint, blocked by PLAT-812, is one
 *   work item holding both.
 * - With a wait on Sarah for the cert open on PAY-12, pasting "Sarah says the
 *   cert will be Friday now" attaches to that item and moves its next expected
 *   date to that Friday, without a second item.
 * - A paste that names no ticket and matches two items asks a question naming
 *   both, and no state changes until it is answered (through Intake.reply).
 * - Editing the status note keeps the user's words through the next sync.
 * - A sync that shows PLAT-812 done records the event and changes the current step.
 * - A sync with no change makes no model call.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import {
  dependencies,
  people,
  proposals,
  workEvents,
  workItemIssues,
  workItems,
} from "@/db/schema";
import { localDate } from "@/lib/dates";
import { nowIso } from "@/lib/ids";
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
import { datesInText } from "./dates";
import { runWorkPass } from "./pass";
import { editNote, workItemDetail } from "./queries";
import { parseState } from "./schema";

const servers: { stop: (force?: boolean) => void }[] = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

const TODAY = localDate();
/** The Friday "Friday" means on the day of the paste. */
const FRIDAY = datesInText("Friday", TODAY)[0] ?? "";
const jiraNow = () => new Date().toISOString().replace("Z", "+0000");

const e = { rationale: "Sarah gave a date", evidence: "Friday now", confidence: 0.9 };
/** Sarah moves the cert to Friday: a reschedule of her wait. */
const sarahClassified = {
  summary: "Sarah: the cert comes Friday",
  question: null,
  confidence: 0.9,
  proposals: [
    {
      kind: "update_dependency",
      dependencyId: "w-cert",
      waitAction: "reschedule",
      expectedAt: FRIDAY,
      ...e,
    },
  ],
};
/** Omar is done with a review, but which: classify asks too. */
const omarClassified = {
  summary: "Omar finished a review",
  question: "Which review did Omar finish?",
  confidence: 0.5,
  proposals: [],
};
const stateOut = (patch: Record<string, unknown>) => ({
  goal: "Renew the payment cert",
  currentStep: "Waiting on Platform to issue the cert (PLAT-812)",
  nextExpectedWhat: null,
  nextExpectedOn: null,
  commitments: [],
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
  // Only the tickets of this test are the user's.
  for (const i of all) if (i.assignee?.name === "me") i.assignee = ana;
  const pay = issues.get("PAY-12");
  const ops = all.find((i) => i.project === "OPS" && i.type !== "Epic" && i.type !== "Sub-task");
  if (!pay || !ops) throw new Error("fixture: tickets");
  Object.assign(pay, {
    type: "Story",
    summary: "Renew the payment gateway cert",
    status: "In Progress",
    assignee: me,
    epic: null,
    parent: null,
    links: [{ type: "Blocks", inward: "PLAT-812" }],
    updated: jiraNow(),
  });
  Object.assign(ops, {
    status: "In Progress",
    assignee: me,
    epic: null,
    parent: null,
    summary: "Rotate the database credentials",
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
      out(sarahClassified),
      out(
        stateOut({
          currentStep: "Waiting on Sarah for the cert",
          nextExpectedWhat: "Sarah delivers the cert",
          nextExpectedOn: FRIDAY,
        }),
      ),
      out(omarClassified),
      out(
        stateOut({
          goal: "Rotate the database credentials",
          currentStep: "Review done; rotate next",
        }),
      ),
      out(
        stateOut({
          currentStep: "PLAT-812 is done: install the new cert on PAY-12",
          nextExpectedWhat: "Sarah delivers the cert",
          nextExpectedOn: FRIDAY,
        }),
      ),
    ],
    "fast-m": [out({ item: "unsure", confidence: 0.4, reason: "Omar waits on both" })],
  });
  const llm = Layer.provideMerge(
    LlmLive,
    Layer.merge(Layer.provideMerge(SyncLive, base), models.layer),
  );
  const layer = Layer.provideMerge(
    Layer.merge(IntakeLive, ProposalsLive),
    Layer.provideMerge(Layer.merge(RetrievalLive, ExecutorLive), llm),
  );
  return { layer, models, issues, opsKey: ops.key };
}

const itemOf = (key: string) =>
  Effect.map(
    query((d) => d.select().from(workItemIssues).where(eq(workItemIssues.issueKey, key)).get()),
    (m) => m?.workItemId ?? null,
  );
const item = (id: string) =>
  query((d) => d.select().from(workItems).where(eq(workItems.id, id)).get());

describe("the work model against the mock Jira (FR-19 AC, Phase 23)", () => {
  test("grouping, attachment, a question, the kept note and the sync events", async () => {
    const { layer, models, issues, opsKey } = setup();
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sync = yield* Sync;
          const intake = yield* Intake;
          yield* sync.run();
          // Contacts and their open waits, as the Waiting page would hold them.
          for (const [id, name] of [
            ["c-sarah", "Sarah Kim"],
            ["c-omar", "Omar Haddad"],
          ] as const)
            yield* query((d) => d.insert(people).values({ id, displayName: name }));
          const wait = (id: string, issueKey: string, owner: string, label: string) =>
            query((d) =>
              d.insert(dependencies).values({
                id,
                issueKey,
                kind: "person",
                label,
                ownerPersonId: owner,
                status: "waiting",
                requestedAt: nowIso(),
              }),
            );
          yield* wait("w-cert", "PAY-12", "c-sarah", "the new cert");
          yield* wait("w-rev1", "PAY-12", "c-omar", "security review");
          yield* wait("w-rev2", opsKey, "c-omar", "credentials review");

          // 1. One item holds PAY-12 and its blocker.
          const first = yield* runWorkPass();
          const cert = (yield* itemOf("PAY-12")) ?? "";
          const plat = yield* itemOf("PLAT-812");
          const ops = (yield* itemOf(opsKey)) ?? "";
          const itemsAfterSync = (yield* query((d) => d.select().from(workItems).all())).length;

          // 2. "Sarah says the cert will be Friday now".
          const sarahTurn = yield* intake.triage({
            text: "Sarah says the cert will be Friday now",
            source: "teams",
            senderPersonId: null,
          });
          const second = yield* runWorkPass();
          const sarahEvent = (yield* query((d) =>
            d.select().from(workEvents).where(eq(workEvents.kind, "message")).all(),
          ))[0];
          const certState = parseState((yield* item(cert))?.state);
          const itemsAfterPaste = (yield* query((d) => d.select().from(workItems).all())).length;

          // 3. A paste naming no ticket that matches both items: a question, no state change.
          const omarTurn = yield* intake.triage({
            text: "Omar says the review is done",
            source: "teams",
            senderPersonId: null,
          });
          const callsBefore = models.calls.length;
          const third = yield* runWorkPass();
          const asked = (yield* query((d) =>
            d.select().from(proposals).where(eq(proposals.inboxItemId, omarTurn.inboxItemId)).all(),
          )).find((p) => (p.payload as { work?: unknown }).work);
          const opsStateBefore = (yield* item(ops))?.state ?? null;
          const callsAtQuestion = models.calls.length;
          // The answer, through the thread like any other.
          const choices = (asked?.payload as { choices?: string[] } | undefined)?.choices ?? [];
          const answer = yield* intake.reply({
            inboxItemId: omarTurn.inboxItemId,
            instruction: choices.find((c) => c.includes(opsKey)) ?? "",
            answers: asked?.id ?? null,
          });
          const fourth = yield* runWorkPass();
          const opsState = parseState((yield* item(ops))?.state);

          // 4. The user edits the note; a sync with no change keeps it and calls nothing.
          yield* editNote(cert, "Cert comes from Sarah on Friday; then I install it.");
          const quietCalls = models.calls.length;
          yield* sync.run();
          const quiet = yield* runWorkPass();
          const keptNote = (yield* workItemDetail("PAY-12"))?.note;
          const callsAfterQuiet = models.calls.length;

          // 5. PLAT-812 is done in Jira: the next sync records it and the step moves on.
          const blocker = issues.get("PLAT-812");
          if (blocker) Object.assign(blocker, { status: "Done", updated: jiraNow() });
          yield* sync.run();
          const fifth = yield* runWorkPass();
          const doneEvent = (yield* query((d) =>
            d.select().from(workEvents).where(eq(workEvents.issueKey, "PLAT-812")).all(),
          )).find((e) => e.kind === "jira_change");
          const finalState = parseState((yield* item(cert))?.state);
          const noteAfter = (yield* workItemDetail("PAY-12"))?.note;
          return {
            first,
            cert,
            plat,
            ops,
            itemsAfterSync,
            sarahTurn,
            second,
            sarahEvent,
            certState,
            itemsAfterPaste,
            callsBefore,
            third,
            asked,
            opsStateBefore,
            callsAtQuestion,
            answer,
            fourth,
            opsState,
            quietCalls,
            quiet,
            keptNote,
            callsAfterQuiet,
            fifth,
            doneEvent,
            finalState,
            noteAfter,
          };
        }),
        layer,
      ),
    );

    // 1. PAY-12 and PLAT-812 in one item; the OPS ticket in its own.
    expect(r.cert).not.toBe("");
    expect(r.plat).toBe(r.cert);
    expect(r.ops).not.toBe(r.cert);
    expect(r.itemsAfterSync).toBe(2);
    expect(r.first.calls).toBe(0);

    // 2. Attached by the named contact's open wait; next expected moves to Friday.
    expect(r.sarahEvent).toMatchObject({ workItemId: r.cert, attachedBy: "code" });
    expect(r.second.calls).toBe(1);
    expect(r.certState?.nextExpected).toEqual({ what: "Sarah delivers the cert", on: FRIDAY });
    expect(r.itemsAfterPaste).toBe(2);

    // 3. A question naming both items; only the attach call, no state update until answered.
    const q = r.asked?.payload as { question: string; work: { type: string } };
    expect(q.work.type).toBe("attach");
    // The cert item is named after its goal since the first state update.
    expect(q.question).toContain("Renew the payment cert");
    expect(q.question).toContain("Rotate the database credentials");
    expect(r.callsAtQuestion - r.callsBefore).toBe(1);
    expect(r.third.calls).toBe(0);
    expect(r.opsStateBefore).toBeNull();
    expect(r.answer.questions).toBe(0);
    expect(r.fourth.calls).toBe(1);
    expect(r.opsState?.currentStep).toBe("Review done; rotate next");

    // 4. The note holds through a sync with no change, which calls no model.
    expect(r.keptNote).toBe("Cert comes from Sarah on Friday; then I install it.");
    expect(r.quiet.calls).toBe(0);
    expect(r.callsAfterQuiet).toBe(r.quietCalls);

    // 5. PLAT-812 done: an event, and the current step moved on.
    expect(r.doneEvent?.summary).toBe("PLAT-812 moved from In Progress to Done");
    expect(r.doneEvent?.workItemId).toBe(r.cert);
    expect(r.fifth.calls).toBe(1);
    expect(r.finalState?.currentStep).toBe("PLAT-812 is done: install the new cert on PAY-12");
    // The note names Sarah's wait, which did not change: the user's words stay.
    expect(r.noteAfter).toBe("Cert comes from Sarah on Friday; then I install it.");
  });
});

describe("the re-read after an approval (D61)", () => {
  test("someone else's comment is recorded once; the proposal's own comment is not", async () => {
    const { layer, issues } = setup();
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sync = yield* Sync;
          yield* sync.run();
          const pay = issues.get("PAY-12");
          const ana = [...issues.values()].find((i) => i.assignee?.name === "ana.b")?.assignee;
          if (!pay || !ana) throw new Error("fixture");
          // A teammate comments in Jira before the next sync...
          const at = jiraNow();
          pay.comments.push({
            id: "77001",
            author: ana,
            body: "Cert is on its way",
            created: at,
            updated: at,
          });
          pay.updated = at;
          // ...and the user approves a comment on the same ticket.
          yield* query((d) =>
            d.insert(proposals).values({
              id: "p-comment",
              kind: "add_comment",
              payload: {
                kind: "add_comment",
                target: "PAY-12",
                bodyMd: "Thanks, installing Friday.",
              },
              status: "pending",
              createdAt: nowIso(),
            }),
          );
          const decided = yield* (yield* Proposals).approve("p-comment");
          yield* sync.run();
          const all = yield* query((d) =>
            d.select().from(workEvents).where(eq(workEvents.issueKey, "PAY-12")).all(),
          );
          return { decided, all };
        }),
        layer,
      ),
    );
    expect(r.decided.status).toBe("executed");
    const comments = r.all.filter((e) => e.kind === "jira_comment" || e.kind === "ticket_edited");
    expect(comments.map((e) => [e.kind, e.ref, e.actor])).toEqual([
      ["jira_comment", "77001", "jira:ana.b"],
    ]);
    expect(r.all.filter((e) => e.kind === "proposal_executed")).toHaveLength(1);
  });
});

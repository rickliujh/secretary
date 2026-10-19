/**
 * The work model over the in-memory Db (Phase 23): events arrive once from each
 * code path, attachment by key, thread and wait, an ambiguous paste becomes a
 * question and waits unattached, the pass makes no call without news and keeps
 * to its budget, a failed update leaves the previous state, questions are
 * rationed, answered and expire, and the user's changes hold.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import {
  communications,
  inboxItems,
  llmCalls,
  proposals,
  workEvents,
  workItemIssues,
  workItems,
} from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { markSent } from "@/services/comms/queries";
import { query } from "@/services/db";
import {
  createDependency,
  logFollowup,
  setDates,
  setStatus,
} from "@/services/dependencies/queries";
import { createPerson } from "@/services/directory/queries";
import { Executor } from "@/services/executor";
import { replaceComments, upsertIssues } from "@/services/sync/upsert";
import { markViewed } from "@/services/tickets/queries";
import { out } from "@/test/intake-layer";
import { blockedByLink, insertIssues, issue, seedSyncState, workTestLayer } from "@/test/work";
import { appendEvents } from "./events";
import { runWorkPass } from "./pass";
import { editNote, mergeItems, moveTicket, splitItem, workItemDetail } from "./queries";
import { answerWorkQuestion, expireQuestions, postQuestion, workThread } from "./questions";
import { parseState } from "./schema";

const noExecutor = Layer.succeed(Executor, {} as never);
const events = query((d) =>
  d.select().from(workEvents).orderBy(workEvents.at, workEvents.id).all(),
);
const items = query((d) => d.select().from(workItems).all());
const itemOf = (key: string) =>
  Effect.map(
    query((d) => d.select().from(workItemIssues).where(eq(workItemIssues.issueKey, key)).get()),
    (m) => m?.workItemId ?? "",
  );
const stateCalls = Effect.map(
  query((d) => d.select().from(llmCalls).where(eq(llmCalls.task, "update_work_state")).all()),
  (r) => r.length,
);

/** A valid `update_work_state` output. */
const state = (patch: Record<string, unknown> = {}) => ({
  goal: "Renew the payment cert",
  currentStep: "Waiting for Platform to issue the cert",
  nextExpectedWhat: null,
  nextExpectedOn: null,
  commitments: [],
  openQuestions: [],
  people: [],
  question: null,
  choices: [],
  ...patch,
});

const comment = (id: string, issueKey: string, body: string) => ({
  id,
  issueKey,
  author: "ana",
  authorDisplay: "Ana",
  body,
  created: "2026-10-11T10:00:00.000Z",
  updated: "2026-10-11T10:00:00.000Z",
});

/** An Inbox thread for message events to come from. */
const seedThread = (text = "pasted") =>
  Effect.gen(function* () {
    const id = newId();
    yield* query((d) =>
      d.insert(inboxItems).values({
        id,
        source: "teams",
        rawText: text,
        receivedAt: nowIso(),
        status: "triaged",
      }),
    );
    return id;
  });

/** PAY-12 (blocked by PLAT-812) and PAY-30: two separate items after a pass. */
const twoItems = Effect.gen(function* () {
  yield* seedSyncState;
  yield* insertIssues([
    issue("PAY-12", {
      summary: "Renew the payment cert",
      raw: { issuelinks: [blockedByLink("PLAT-812")] },
    }),
    issue("PLAT-812", { summary: "Issue the cert", assignee: "sam", sprint: null, stale: true }),
    issue("PAY-30", { summary: "Refund report export" }),
  ]);
  yield* runWorkPass();
  return { cert: yield* itemOf("PAY-12"), refund: yield* itemOf("PAY-30") };
});

describe("events arrive once from each code path (D61)", () => {
  test("sync: a changed field and a new comment on a cached ticket; nothing for a new one", async () => {
    const { run } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        yield* seedSyncState;
        const before = issue("PAY-12");
        const seen = yield* upsertIssues([before]);
        yield* replaceComments(["PAY-12"], [], { cachedBefore: seen });
        const first = (yield* events).length;
        const changed = { ...before, status: "In Review", dueDate: "2026-10-23" };
        const cached = yield* upsertIssues([changed, issue("PAY-99")]);
        yield* replaceComments(
          ["PAY-12", "PAY-99"],
          [comment("c1", "PAY-12", "Done on my side"), comment("c2", "PAY-99", "Old")],
          { cachedBefore: cached },
        );
        // The same page again: nothing changed, nothing recorded.
        const again = yield* upsertIssues([changed]);
        yield* replaceComments(["PAY-12"], [comment("c1", "PAY-12", "Done on my side")], {
          cachedBefore: again,
        });
        // The user's own edit from the app, and an approved proposal's re-read.
        yield* upsertIssues([{ ...changed, summary: "Renew the cert" }], {
          by: "user",
          fields: ["summary"],
          commentIds: [],
        });
        yield* upsertIssues([{ ...changed, summary: "Renew it" }], {
          by: "proposal",
          fields: ["summary"],
          commentIds: [],
        });
        return { first, all: yield* events };
      }),
    );
    expect(r.first).toBe(0);
    expect(r.all.map((e) => [e.kind, e.issueKey, e.actor, e.summary])).toEqual([
      ["jira_change", "PAY-12", "sync", "PAY-12 moved from In Progress to In Review"],
      ["jira_change", "PAY-12", "sync", "PAY-12 due date set to 2026-10-23"],
      ["jira_comment", "PAY-12", "jira:ana", "Ana commented on PAY-12"],
      ["ticket_edited", "PAY-12", "me", 'PAY-12 renamed to "Renew the cert"'],
    ]);
  });

  test("waits: opened, chased, rescheduled, resolved; none when the Executor writes", async () => {
    const { run } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        const sarah = yield* createPerson({ displayName: "Sarah Kim" });
        const id = yield* createDependency({
          issueKey: "PAY-12",
          kind: "person",
          label: "the cert",
          ownerPersonId: sarah,
        });
        yield* logFollowup(id, { channel: "teams", summary: "Asked again" });
        yield* setDates(id, { expectedAt: "2026-10-23" }, { mirror: false });
        yield* setStatus(id, "resolved", { mirror: false });
        yield* setDates(id, { expectedAt: "2026-10-24" }, { mirror: false, event: false });
        yield* logFollowup(id, { channel: "teams", summary: "x" }, undefined, { event: false });
        return yield* events;
      }).pipe(Effect.provide(noExecutor)),
    );
    expect(r.map((e) => e.kind)).toEqual([
      "wait_opened",
      "wait_chased",
      "wait_rescheduled",
      "wait_resolved",
    ]);
    expect(r[0]?.summary).toBe("Waiting on Sarah Kim for the cert on PAY-12");
    expect(r.every((e) => e.issueKey === "PAY-12")).toBe(true);
  });

  test("a draft marked sent is one event, not a second one for its chase", async () => {
    const { run } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        const dep = yield* createDependency({
          issueKey: "PAY-12",
          kind: "team",
          label: "the cert",
        });
        yield* query((d) =>
          d.insert(communications).values({
            id: "c1",
            kind: "teams",
            intent: "chase",
            issueKeys: ["PAY-12"],
            dependencyId: dep,
            bodyMd: "Any news on the cert?",
            createdAt: nowIso(),
          }),
        );
        yield* markSent("c1");
        return yield* events;
      }),
    );
    expect(r.map((e) => e.kind)).toEqual(["wait_opened", "draft_sent"]);
  });

  test("opening a ticket is a view, recorded once in half an hour and already applied", async () => {
    const { run } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        yield* markViewed("PAY-12");
        yield* markViewed("PAY-12");
        return yield* events;
      }),
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: "ticket_viewed", applied: true, attachedBy: "none" });
  });
});

describe("attachment (D61)", () => {
  test("by ticket key and by the wait's ticket; a view never asks for an update", async () => {
    const { run, models } = workTestLayer({ "std-m": [out(state())] });
    const r = await run(
      Effect.gen(function* () {
        const { cert } = yield* twoItems;
        const dep = yield* createDependency({ issueKey: "PAY-12", kind: "team", label: "cert" });
        yield* query((d) => d.delete(workEvents));
        yield* appendEvents([
          {
            kind: "jira_change",
            actor: "sync",
            issueKey: "PLAT-812",
            summary: "PLAT-812 moved from In Progress to Done",
            data: { field: "status", from: "In Progress", to: "Done" },
          },
          {
            kind: "draft_sent",
            actor: "me",
            summary: "Sent a chase",
            data: { dependencyId: dep, text: "Any news?" },
          },
        ]);
        yield* markViewed("PAY-30");
        yield* runWorkPass();
        return { cert, all: yield* events };
      }),
    );
    // The new wait's playbook card (Phase 26) is the secretary's, already attached.
    const real = r.all.filter((e) => e.kind !== "ticket_viewed" && e.kind !== "outcome_offered");
    expect(real.map((e) => [e.workItemId, e.attachedBy, e.applied])).toEqual([
      [r.cert, "code", true],
      [r.cert, "code", true],
    ]);
    // One state update, for the cert item only: the view on PAY-30 asks for none.
    expect(models.calls).toHaveLength(1);
  });

  test("by thread: a message naming no ticket joins the item its thread is about", async () => {
    const { run } = workTestLayer({ "std-m": [out(state())] });
    const r = await run(
      Effect.gen(function* () {
        const { cert } = yield* twoItems;
        const t = yield* seedThread();
        yield* appendEvents([
          {
            kind: "message",
            actor: "me",
            summary: "PAY-12 first",
            data: { inboxItemId: t, intakeItemId: "i1", quote: "About PAY-12", keys: ["PAY-12"] },
          },
          {
            kind: "message",
            actor: "me",
            summary: "a follow-up",
            data: { inboxItemId: t, intakeItemId: "i2", quote: "and it is urgent", keys: [] },
          },
        ]);
        yield* runWorkPass();
        return { cert, all: (yield* events).filter((e) => e.kind === "message") };
      }),
    );
    expect(r.all.map((e) => [e.summary, e.workItemId, e.attachedBy])).toEqual([
      ["PAY-12 first", r.cert, "code"],
      ["a follow-up", r.cert, "code"],
    ]);
  });

  test("an ambiguous paste asks in its thread, waits unattached, and changes no state", async () => {
    const unsure = { item: "unsure", confidence: 0.3, reason: "Sarah owns both" };
    const { run, models } = workTestLayer({ "fast-m": [out(unsure)] });
    const r = await run(
      Effect.gen(function* () {
        const ids = yield* twoItems;
        const sarah = yield* createPerson({ displayName: "Sarah Kim" });
        yield* createDependency({
          issueKey: "PAY-12",
          kind: "person",
          label: "cert",
          ownerPersonId: sarah,
        });
        yield* createDependency({
          issueKey: "PAY-30",
          kind: "person",
          label: "refund data",
          ownerPersonId: sarah,
        });
        yield* query((d) => d.delete(workEvents));
        const thread = yield* seedThread("Sarah says it will be Friday now");
        yield* appendEvents([
          {
            kind: "message",
            actor: `contact:${sarah}`,
            summary: "Sarah says Friday now",
            data: {
              inboxItemId: thread,
              intakeItemId: "i1",
              quote: "Sarah says it will be Friday now",
              keys: [],
              contactIds: [sarah],
            },
          },
        ]);
        const pass = yield* runWorkPass();
        const asked = yield* query((d) =>
          d.select().from(proposals).where(eq(proposals.inboxItemId, thread)).all(),
        );
        const ev = (yield* events)[0];
        const second = yield* runWorkPass();
        return { ...ids, pass, second, asked, ev, items: yield* items };
      }),
    );
    expect(r.asked).toHaveLength(1);
    const payload = r.asked[0]?.payload as {
      question: string;
      choices: string[];
      work: { type: string; itemIds: string[] };
    };
    expect(payload.work.type).toBe("attach");
    expect(payload.question).toContain("Renew the payment cert");
    expect(payload.question).toContain("Refund report export");
    expect(payload.choices).toHaveLength(3);
    expect(r.ev?.workItemId).toBeNull();
    expect(r.ev?.attachedBy).toBeNull();
    // One attach call and no state update; the next pass asks and calls nothing.
    expect(models.calls.map((c) => c.model)).toEqual(["fast-m"]);
    expect(r.items.every((i) => i.state === null)).toBe(true);
    expect(r.second.asked).toBe(0);
  });

  test("when the model is sure, the event attaches to the item it named", async () => {
    const sure = { item: "item 2", confidence: 0.9, reason: "refund" };
    const { run } = workTestLayer({ "fast-m": [out(sure)], "std-m": [out(state())] });
    const r = await run(
      Effect.gen(function* () {
        const ids = yield* twoItems;
        const sarah = yield* createPerson({ displayName: "Sarah Kim" });
        for (const k of ["PAY-12", "PAY-30"])
          yield* createDependency({ issueKey: k, kind: "person", label: k, ownerPersonId: sarah });
        yield* query((d) => d.delete(workEvents));
        yield* appendEvents([
          {
            kind: "message",
            actor: `contact:${sarah}`,
            summary: "Sarah on the refunds",
            data: {
              inboxItemId: "x",
              intakeItemId: "i1",
              quote: "the refund data is late",
              keys: [],
              contactIds: [sarah],
            },
          },
        ]);
        yield* runWorkPass();
        return { ...ids, ev: (yield* events)[0] };
      }),
    );
    const second = [r.cert, r.refund].sort()[1];
    expect(r.ev).toMatchObject({ workItemId: second, attachedBy: "model" });
  });
});

describe("the pass", () => {
  test("a pass with nothing new makes no model call", async () => {
    const { run, models } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        yield* twoItems;
        const first = yield* runWorkPass();
        // A sync that changed nothing: the same rows written again.
        yield* upsertIssues([issue("PAY-30", { summary: "Refund report export" })]);
        const second = yield* runWorkPass();
        return { first, second };
      }),
    );
    expect(models.calls).toHaveLength(0);
    expect(r.first.calls + r.second.calls).toBe(0);
  });

  test("the daily budget holds; the current item goes first; the rest waits", async () => {
    const { run, models } = workTestLayer(
      { "std-m": [out(state()), out(state({ goal: "Refunds" }))] },
      { work: { enabled: true, questionsPerDay: 3, stateCallsPerDay: 1, groupSizeCap: 8 } },
    );
    const r = await run(
      Effect.gen(function* () {
        const { cert, refund } = yield* twoItems;
        yield* query((d) =>
          d.update(workItems).set({ current: true }).where(eq(workItems.id, refund)),
        );
        yield* appendEvents([
          {
            kind: "note",
            actor: "me",
            summary: "cert note",
            workItemId: cert,
            attachedBy: "user",
            data: { text: "x" },
          },
          {
            kind: "note",
            actor: "me",
            summary: "refund note",
            workItemId: refund,
            attachedBy: "user",
            data: { text: "y" },
          },
        ]);
        const pass = yield* runWorkPass();
        const again = yield* runWorkPass();
        return { pass, again, calls: yield* stateCalls, refund };
      }),
    );
    expect(r.pass.calls).toBe(1);
    expect(r.pass.deferred).toBe(1);
    expect(r.again.calls).toBe(0);
    expect(r.calls).toBe(1);
    expect(JSON.stringify(models.calls[0]?.prompt)).toContain("refund note");
  });

  test("a result that fails code's checks twice keeps the previous state with needs_look", async () => {
    const invented = state({ people: [{ personId: null, name: "Zed Unknown", role: "owner" }] });
    const { run, models } = workTestLayer({
      "std-m": [out(state()), out(invented), out(invented)],
    });
    const r = await run(
      Effect.gen(function* () {
        const { cert } = yield* twoItems;
        yield* appendEvents([
          {
            kind: "note",
            actor: "me",
            summary: "first",
            workItemId: cert,
            attachedBy: "user",
            data: { text: "on it" },
          },
        ]);
        yield* runWorkPass();
        const before = (yield* items).find((i) => i.id === cert);
        yield* appendEvents([
          {
            kind: "note",
            actor: "me",
            summary: "second",
            workItemId: cert,
            attachedBy: "user",
            data: { text: "still on it" },
          },
        ]);
        const pass = yield* runWorkPass();
        const after = (yield* items).find((i) => i.id === cert);
        const left = (yield* events).filter((e) => !e.applied && e.workItemId === cert);
        return { before, after, pass, left };
      }),
    );
    expect(models.calls).toHaveLength(3);
    expect(JSON.stringify(models.calls[2]?.prompt)).toContain("Zed Unknown");
    expect(r.pass.failed).toBe(1);
    expect(r.after?.needsLook).toBe(true);
    expect(r.after?.state).toEqual(r.before?.state);
    expect(r.left).toHaveLength(0);
  });

  test("the goal names the item until the user renames it", async () => {
    const { run } = workTestLayer({ "std-m": [out(state({ goal: "Payment cert renewal" }))] });
    const r = await run(
      Effect.gen(function* () {
        const { cert } = yield* twoItems;
        yield* appendEvents([
          {
            kind: "note",
            actor: "me",
            summary: "n",
            workItemId: cert,
            attachedBy: "user",
            data: { text: "n" },
          },
        ]);
        yield* runWorkPass();
        return (yield* items).find((i) => i.id === cert);
      }),
    );
    expect(r?.name).toBe("Payment cert renewal");
    expect(parseState(r?.state)?.currentStep).toBe("Waiting for Platform to issue the cert");
  });
});

describe("questions (FR-19.4)", () => {
  test("grouping doubts are rationed per day, asked once each", async () => {
    const { run } = workTestLayer(
      {},
      {
        work: { enabled: true, questionsPerDay: 1, stateCallsPerDay: 10, groupSizeCap: 8 },
      },
    );
    const r = await run(
      Effect.gen(function* () {
        const { cert, refund } = yield* twoItems;
        yield* insertIssues([issue("OPS-1", { summary: "Disk alerts" })]);
        yield* runWorkPass();
        const ops = yield* itemOf("OPS-1");
        yield* upsertIssues([
          issue("PAY-30", {
            summary: "Refund report export",
            raw: { issuelinks: [blockedByLink("PAY-12"), blockedByLink("OPS-1")] },
          }),
        ]);
        const pass = yield* runWorkPass();
        const again = yield* runWorkPass();
        const asked = yield* query((d) =>
          d.select().from(proposals).where(eq(proposals.kind, "needs_clarification")).all(),
        );
        return { cert, refund, ops, pass, again, asked };
      }),
    );
    expect(r.pass.asked).toBe(1);
    expect(r.again.asked).toBe(0);
    expect(r.asked).toHaveLength(1);
    const p = r.asked[0]?.payload as { work: { type: string }; choices: string[] };
    expect(p.work.type).toBe("group");
    expect(p.choices).toEqual(["Yes, one piece of work", "No, keep them apart"]);
  });

  test("answers attach the event, merge or keep apart; an unclear one asks again", async () => {
    const { run } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        const { cert, refund } = yield* twoItems;
        const [ev] = yield* appendEvents([
          {
            kind: "message",
            actor: "me",
            summary: "which?",
            data: { inboxItemId: "t", intakeItemId: "i", quote: "the thing" },
          },
        ]);
        const thread = yield* seedThread();
        const ask = (work: Parameters<typeof postQuestion>[1]["work"], choices: string[]) =>
          Effect.flatMap(postQuestion(thread, { question: "Which?", choices, work }), (id) =>
            query((d) => d.select().from(proposals).where(eq(proposals.id, id)).get()),
          );
        const attachQ = yield* ask({ type: "attach", eventId: ev ?? "", itemIds: [cert, refund] }, [
          "Renew the payment cert (PAY-12, PLAT-812)",
          "Refund report export (PAY-30)",
          "None of these",
        ]);
        const unclear = yield* answerWorkQuestion(attachQ as never, "hmm");
        const byKey = yield* answerWorkQuestion(attachQ as never, "the PAY-30 one");
        const attached = (yield* events).find((e) => e.id === ev);
        const groupQ = yield* ask({ type: "group", key: "g", itemIds: [cert, refund] }, [
          "Yes, one piece of work",
          "No, keep them apart",
        ]);
        const apart = yield* answerWorkQuestion(groupQ as never, "No, keep them apart");
        const together = yield* answerWorkQuestion(groupQ as never, "yes");
        return {
          cert,
          refund,
          unclear,
          byKey,
          attached,
          apart,
          together,
          items: yield* items,
          pending: yield* query((d) =>
            d.select().from(proposals).where(eq(proposals.status, "pending")).all(),
          ),
        };
      }),
    );
    expect(r.unclear.reask).toBe(true);
    expect(r.byKey).toEqual({ message: 'Added to "Refund report export".', reask: false });
    expect(r.attached).toMatchObject({
      workItemId: r.refund,
      attachedBy: "answer",
      applied: false,
    });
    expect(r.apart.message).toBe("Kept them apart.");
    expect(r.together.message).toBe("Merged them into one work item.");
    expect(r.items.find((i) => i.id === r.refund)).toMatchObject({
      status: "dismissed",
      mergedInto: r.cert,
    });
  });

  test("an unanswered question expires after 7 days; its event goes on the timeline as unsure", async () => {
    const { run } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        const { cert, refund } = yield* twoItems;
        const [ev] = yield* appendEvents([
          {
            kind: "message",
            actor: "me",
            summary: "which?",
            data: { inboxItemId: "t", intakeItemId: "i", quote: "x", question: "q" },
          },
        ]);
        const thread = yield* seedThread();
        const id = yield* postQuestion(thread, {
          question: "Which?",
          choices: [],
          work: { type: "attach", eventId: ev ?? "", itemIds: [cert, refund] },
        });
        const soon = yield* expireQuestions(new Date(Date.now() + 86_400_000));
        const late = yield* expireQuestions(new Date(Date.now() + 8 * 86_400_000));
        const q = yield* query((d) => d.select().from(proposals).where(eq(proposals.id, id)).get());
        return { cert, soon, late, q, ev: (yield* events).find((e) => e.id === ev) };
      }),
    );
    expect(r.soon).toBe(0);
    expect(r.late).toBe(1);
    expect(r.q?.status).toBe("rejected");
    expect(r.ev).toMatchObject({ workItemId: r.cert, attachedBy: "unsure", applied: true });
  });
});

describe("the user's changes", () => {
  /** PAY-12 blocked by PAY-13, both the user's: one item. */
  const linkedPair = Effect.gen(function* () {
    yield* seedSyncState;
    yield* insertIssues([
      issue("PAY-12", { raw: { issuelinks: [blockedByLink("PAY-13")] } }),
      issue("PAY-13", { summary: "Rotate the keys" }),
    ]);
    yield* runWorkPass();
    return (yield* itemOf("PAY-12")) ?? "";
  });
  const questions = query((d) =>
    d.select().from(proposals).where(eq(proposals.kind, "needs_clarification")).all(),
  );

  test("a split holds on the next runs and is never asked about (H1)", async () => {
    const { run } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        const first = yield* linkedPair;
        const split = yield* splitItem(first, ["PAY-13"]);
        yield* runWorkPass();
        yield* runWorkPass();
        return {
          first,
          split,
          a: yield* itemOf("PAY-12"),
          b: yield* itemOf("PAY-13"),
          asked: yield* questions,
        };
      }),
    );
    expect(r.split).not.toBeNull();
    expect(r.a).toBe(r.first);
    expect(r.b).toBe(r.split ?? "");
    expect(r.asked).toEqual([]);
  });

  test("a ticket moved to an item of its own stays there and is never asked about (H1)", async () => {
    const { run } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        const first = yield* linkedPair;
        const moved = yield* moveTicket("PAY-13", null);
        yield* runWorkPass();
        yield* runWorkPass();
        return { first, moved, b: yield* itemOf("PAY-13"), asked: yield* questions };
      }),
    );
    expect(r.moved).not.toBeNull();
    expect(r.moved).not.toBe(r.first);
    expect(r.b).toBe(r.moved ?? "");
    expect(r.asked).toEqual([]);
  });

  test("a ticket the item waits on never starts an item; one moved elsewhere is fine (L3)", async () => {
    const { run } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        const { cert, refund } = yield* twoItems;
        const split = yield* splitItem(cert, ["PLAT-812"]);
        const own = yield* moveTicket("PLAT-812", null);
        yield* moveTicket("PAY-30", cert);
        yield* runWorkPass();
        return {
          cert,
          refund,
          split,
          own,
          plat: yield* itemOf("PLAT-812"),
          pay30: yield* itemOf("PAY-30"),
          all: yield* items,
        };
      }),
    );
    expect(r.split).toBeNull();
    expect(r.own).toBeNull();
    expect(r.plat).toBe(r.cert);
    expect(r.pay30).toBe(r.cert);
    // The refund item lost its only ticket.
    expect(r.all.find((i) => i.id === r.refund)?.status).toBe("dismissed");
  });

  test("an item left with only tickets it waits on is dismissed and lets them go (L3)", async () => {
    const { run } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        const { cert, refund } = yield* twoItems;
        // PAY-12 moves to the refund item: the cert item keeps only PLAT-812.
        yield* moveTicket("PAY-12", refund);
        yield* runWorkPass();
        return { cert, refund, plat: yield* itemOf("PLAT-812"), all: yield* items };
      }),
    );
    expect(r.all.find((i) => i.id === r.cert)?.status).toBe("dismissed");
    // Released, then grouped again with the ticket it blocks.
    expect(r.plat).toBe(r.refund);
  });

  test("an edited note is kept word for word until a fact it names changes", async () => {
    const { run } = workTestLayer({ "std-m": [out(state()), out(state())] });
    const r = await run(
      Effect.gen(function* () {
        const { cert } = yield* twoItems;
        yield* editNote(cert, "PAY-12 is with me, cert due from Platform.");
        yield* appendEvents([
          {
            kind: "note",
            actor: "me",
            summary: "n",
            workItemId: cert,
            attachedBy: "user",
            data: { text: "n" },
          },
        ]);
        yield* runWorkPass();
        const kept = (yield* workItemDetail("PAY-12"))?.note;
        // PAY-12 changes: the note no longer holds.
        yield* upsertIssues([
          issue("PAY-12", {
            summary: "Renew the payment cert",
            status: "In Review",
            raw: { issuelinks: [blockedByLink("PLAT-812")] },
          }),
        ]);
        yield* runWorkPass();
        const released = yield* workItemDetail("PAY-12");
        return { kept, released };
      }),
    );
    expect(r.kept).toBe("PAY-12 is with me, cert due from Platform.");
    expect(r.released?.item.noteEdited).toBe(false);
    expect(r.released?.note).not.toBe("PAY-12 is with me, cert due from Platform.");
  });

  test("merging moves the tickets and the timeline", async () => {
    const { run } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        const { cert, refund } = yield* twoItems;
        yield* appendEvents([
          {
            kind: "note",
            actor: "me",
            summary: "refund",
            workItemId: refund,
            attachedBy: "user",
            applied: true,
          },
        ]);
        yield* editNote(cert, "Mine, keep it.");
        const thread = yield* workThread(refund, "Refunds");
        const q = yield* postQuestion(thread, {
          question: "What did you promise Dana?",
          choices: [],
          work: { type: "meaning", itemId: refund },
        });
        yield* mergeItems(refund, cert);
        return {
          cert,
          keys: (yield* query((d) =>
            d.select().from(workItemIssues).where(eq(workItemIssues.workItemId, cert)).all(),
          ))
            .map((m) => m.issueKey)
            .sort(),
          ev: (yield* events).filter((e) => e.summary === "refund"),
          thread: yield* query((d) =>
            d.select().from(inboxItems).where(eq(inboxItems.id, thread)).get(),
          ),
          q: yield* query((d) => d.select().from(proposals).where(eq(proposals.id, q)).get()),
          note: (yield* workItemDetail("PAY-12"))?.note,
        };
      }),
    );
    expect(r.keys).toEqual(["PAY-12", "PAY-30", "PLAT-812"]);
    // Moved, and folded into the survivor's state on the next pass (L2).
    expect(r.ev[0]).toMatchObject({ workItemId: r.cert, applied: false });
    expect(r.thread?.workItemId).toBe(r.cert);
    expect(r.q?.payload).toMatchObject({ work: { itemId: r.cert } });
    expect(r.note).toBe("Mine, keep it.");
  });
});

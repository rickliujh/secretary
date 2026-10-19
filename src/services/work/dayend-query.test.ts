/**
 * The end-of-day pass over the in-memory Db (FR-19.9, D63): one `secretary`
 * item a day, replaced on a rerun; the questions the ration left unasked are
 * released (at most five, never into a parked thread) and do not count against
 * the ration; `day_end` events once per item, applied; Done files the page;
 * the timed run does not run twice; nothing while the work model is off.
 */
import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import {
  inboxItems,
  inboxMessages,
  proposals,
  workEvents,
  workItemIssues,
  workItems,
} from "@/db/schema";
import { localDate } from "@/lib/dates";
import { query } from "@/services/db";
import { defaultSettings } from "@/services/settings/schema";
import { insertIssues, issue, seedSyncState, workTestLayer } from "@/test/work";
import { tomorrowOf } from "./dayend";
import {
  closeDayEnd,
  dayEndItem,
  dayEndKey,
  dayEndOf,
  dayEndRanOn,
  runDayEnd,
} from "./dayend-query";
import { appendEvents } from "./events";
import { runWorkPass } from "./pass";
import {
  answerWorkQuestion,
  askQuestions,
  UNASKED_LIMIT,
  unaskedOf,
  workThread,
} from "./questions";
import { KEEP_APART, ONE_PIECE } from "./schema";

const itemOf = (key: string) =>
  Effect.map(
    query((d) => d.select().from(workItemIssues).where(eq(workItemIssues.issueKey, key)).get()),
    (m) => m?.workItemId ?? "",
  );

const dayStart = () => new Date(new Date().setHours(0, 0, 0, 0)).toISOString();

/** PAY-12 due tomorrow and OPS-7, grouped into two items by a pass that asks nothing. */
const twoItems = Effect.gen(function* () {
  yield* seedSyncState;
  yield* insertIssues([
    issue("PAY-12", { summary: "Renew the payment cert", dueDate: tomorrowOf(localDate()) }),
    issue("OPS-7", { summary: "Rotate the database credentials" }),
  ]);
  yield* runWorkPass();
  return { cert: yield* itemOf("PAY-12"), ops: yield* itemOf("OPS-7") };
});

const ok = <T extends { skipped?: unknown }>(r: T) => {
  if (r.skipped) throw new Error(`skipped: ${String(r.skipped)}`);
  return r as Exclude<T, { skipped: string }>;
};

describe("the end-of-day pass (D63)", () => {
  test("releases the questions the ration left, outside the ration, with their choices", async () => {
    const { run } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        const { cert, ops } = yield* twoItems;
        // The ration is one a day: the first meaning question goes out, the rest wait.
        const asked = yield* askQuestions({
          attach: [],
          meaning: [
            { itemId: cert, question: "Who installs the cert?", choices: ["Me", "Platform"] },
            { itemId: ops, question: "Prod only?", choices: ["Yes", "No"] },
          ],
          doubts: [{ reason: "items", itemIds: [cert, ops] }],
          perDay: 1,
          dayStart: dayStart(),
        });
        const unasked = yield* unaskedOf(localDate());
        const end = ok(yield* runDayEnd({ trigger: "button" }));
        const released = yield* query((d) =>
          d.select().from(proposals).where(eq(proposals.kind, "needs_clarification")).all(),
        );
        const left = yield* unaskedOf(localDate());
        // Released questions do not count: with two a day, one more goes out.
        const more = yield* askQuestions({
          attach: [],
          meaning: [],
          doubts: [{ reason: "cap", itemIds: [ops, cert] }],
          perDay: 2,
          dayStart: dayStart(),
        });
        const page = yield* query((d) =>
          d.select().from(inboxItems).where(eq(inboxItems.id, end.id)).get(),
        );
        return { cert, ops, asked, unasked, end, released, left, more, page };
      }),
    );
    expect(r.asked).toHaveLength(1);
    expect(r.unasked.map((a) => a.type)).toEqual(["meaning", "group"]);
    expect(r.end.released).toBe(2);
    expect(r.end.questions.map((q) => [q.question, q.choices])).toEqual([
      ["Prod only?", ["Yes", "No"]],
      [expect.stringContaining("one piece of work?"), [ONE_PIECE, KEEP_APART]],
    ]);
    const payloads = r.released.map((p) => p.payload as { releasedOn?: string; question: string });
    expect(payloads.filter((p) => p.releasedOn === localDate())).toHaveLength(2);
    expect(
      payloads.find((p) => p.question === "Who installs the cert?")?.releasedOn,
    ).toBeUndefined();
    expect(r.left).toEqual([]);
    expect(r.more).toHaveLength(1);
    expect(r.page).toMatchObject({
      source: "secretary",
      status: "triaged",
      situationKey: dayEndKey(localDate()),
      workItemId: null,
    });
    expect(dayEndOf(r.page?.triage)?.questionIds).toHaveLength(2);
    expect(r.page?.rawText).toContain("2 questions I could not settle");
    expect(r.page?.rawText).toContain("PAY-12 Renew the payment cert, due");
  });

  test("never releases a question into a parked thread; it waits there", async () => {
    const { run } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        const { ops } = yield* twoItems;
        yield* askQuestions({
          attach: [],
          meaning: [{ itemId: ops, question: "Prod only?", choices: [] }],
          doubts: [],
          perDay: 0,
          dayStart: dayStart(),
        });
        const thread = yield* workThread(ops, "Rotate");
        yield* query((d) =>
          d.update(inboxItems).set({ status: "parked" }).where(eq(inboxItems.id, thread)),
        );
        const end = ok(yield* runDayEnd());
        const posted = yield* query((d) =>
          d.select().from(proposals).where(eq(proposals.inboxItemId, thread)).all(),
        );
        return { end, posted, left: yield* unaskedOf(localDate()) };
      }),
    );
    expect(r.end.released).toBe(0);
    expect(r.posted).toHaveLength(0);
    expect(r.left).toHaveLength(1);
  });

  test("releases at most five, most consequential first", async () => {
    const { run } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        yield* seedSyncState;
        const keys = ["PAY-1", "PAY-2", "OPS-3", "WEB-4", "APP-5", "DOC-6", "INF-7"];
        yield* insertIssues(keys.map((k) => issue(k, { summary: `Work on ${k}` })));
        yield* runWorkPass();
        const ids: string[] = [];
        for (const k of keys) ids.push(yield* itemOf(k));
        yield* askQuestions({
          attach: [],
          meaning: ids.slice(0, 6).map((itemId, i) => ({
            itemId,
            question: `Question ${i + 1}?`,
            choices: [],
          })),
          doubts: [{ reason: "items", itemIds: [ids[5] ?? "", ids[6] ?? ""] }],
          perDay: 0,
          dayStart: dayStart(),
        });
        const end = ok(yield* runDayEnd());
        return { end, left: yield* unaskedOf(localDate()) };
      }),
    );
    expect(r.end.released).toBe(5);
    expect(r.end.questions.map((q) => q.question)).toEqual([
      "Question 1?",
      "Question 2?",
      "Question 3?",
      "Question 4?",
      "Question 5?",
    ]);
    expect(r.left.map((a) => a.type)).toEqual(["meaning", "group"]);
  });

  test("a rerun replaces the page; answered questions drop off; events once; Done files it", async () => {
    const { run } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        const { cert, ops } = yield* twoItems;
        yield* askQuestions({
          attach: [],
          meaning: [
            { itemId: cert, question: "Who installs the cert?", choices: ["Me", "Platform"] },
            { itemId: ops, question: "Prod only?", choices: ["Yes", "No"] },
          ],
          doubts: [],
          perDay: 0,
          dayStart: dayStart(),
        });
        const first = ok(yield* runDayEnd());
        const firstPage = yield* query((d) =>
          d.select().from(inboxItems).where(eq(inboxItems.id, first.id)).get(),
        );
        // The user answers one in its thread and notes something on the cert.
        const answered = dayEndOf(firstPage?.triage)?.questionIds[0] ?? "";
        yield* query((d) =>
          d
            .update(proposals)
            .set({ status: "executed", result: { answer: "Me" } })
            .where(eq(proposals.id, answered)),
        );
        yield* appendEvents([
          {
            kind: "note",
            actor: "me",
            summary: "Your note",
            data: { text: "Cert files are with Platform" },
            workItemId: cert,
            attachedBy: "user",
          },
        ]);
        const timed = yield* runDayEnd({ trigger: "time" });
        const second = ok(yield* runDayEnd({ trigger: "chat" }));
        const pages = yield* query((d) =>
          d.select().from(inboxItems).where(eq(inboxItems.source, "secretary")).all(),
        );
        const events = yield* query((d) =>
          d.select().from(workEvents).where(eq(workEvents.kind, "day_end")).all(),
        );
        yield* closeDayEnd(second.id);
        const closed = yield* query((d) =>
          d.select().from(inboxItems).where(eq(inboxItems.id, second.id)).get(),
        );
        const stillOpen = yield* query((d) =>
          d
            .select()
            .from(proposals)
            .where(and(eq(proposals.kind, "needs_clarification"), eq(proposals.status, "pending")))
            .all(),
        );
        return {
          cert,
          ops,
          first,
          firstPage,
          timed,
          second,
          pages,
          events,
          closed,
          stillOpen,
          ran: yield* dayEndRanOn(localDate()),
        };
      }),
    );
    expect(r.first.created).toBe(true);
    expect(r.first.questions).toHaveLength(2);
    expect(r.timed).toEqual({ skipped: "ran", id: r.first.id });
    expect(r.second.created).toBe(false);
    expect(r.second.id).toBe(r.first.id);
    expect(r.pages).toHaveLength(1);
    expect(r.pages[0]?.rawText).toContain("You: Cert files are with Platform");
    expect(r.firstPage?.rawText).not.toContain("Cert files");
    expect(r.second.questions.map((q) => q.question)).toEqual(["Prod only?"]);
    // One event a day on each item listed, applied, so the state update never reads it.
    expect(r.events.map((e) => e.workItemId).sort()).toEqual([r.cert, r.ops].sort());
    expect(r.events.every((e) => e.applied && e.actor === "secretary")).toBe(true);
    expect(r.closed?.status).toBe("filed");
    expect(r.stillOpen).toHaveLength(1);
    expect(r.ran).toBe(true);
  });

  test("does nothing while the work model is off", async () => {
    const { run } = workTestLayer({}, { work: { ...defaultSettings().work, enabled: false } });
    const r = await run(runDayEnd());
    expect(r).toEqual({ skipped: "disabled" });
  });
});

/** Seven items, one ticket each, for the cap. */
const sevenItems = Effect.gen(function* () {
  yield* seedSyncState;
  const keys = ["PAY-1", "PAY-2", "OPS-3", "WEB-4", "APP-5", "DOC-6", "INF-7"];
  yield* insertIssues(keys.map((k) => issue(k, { summary: `Work on ${k}` })));
  yield* runWorkPass();
  const ids: string[] = [];
  for (const k of keys) ids.push(yield* itemOf(k));
  return ids;
});

const holdBack = (ids: readonly string[], n: number) =>
  askQuestions({
    attach: [],
    meaning: ids.slice(0, n).map((itemId, i) => ({
      itemId,
      question: `Question ${i + 1}?`,
      choices: [],
    })),
    doubts: [],
    perDay: 0,
    dayStart: dayStart(),
  });

const questionsOf = query((d) =>
  d.select().from(proposals).where(eq(proposals.kind, "needs_clarification")).all(),
);

describe("review fixes (D63)", () => {
  test("M1: a chat run and a button run at once write one page and release each question once", async () => {
    const { run } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        const { cert, ops } = yield* twoItems;
        yield* askQuestions({
          attach: [],
          meaning: [
            { itemId: cert, question: "Who installs the cert?", choices: [] },
            { itemId: ops, question: "Prod only?", choices: [] },
          ],
          doubts: [],
          perDay: 0,
          dayStart: dayStart(),
        });
        const both = yield* Effect.all(
          [runDayEnd({ trigger: "chat" }), runDayEnd({ trigger: "button" })],
          { concurrency: "unbounded" },
        );
        const pages = yield* query((d) =>
          d.select().from(inboxItems).where(eq(inboxItems.source, "secretary")).all(),
        );
        const threads = yield* query((d) =>
          d.select().from(inboxItems).where(eq(inboxItems.source, "other")).all(),
        );
        return { both, pages, threads, questions: yield* questionsOf };
      }),
    );
    expect(r.both.map((x) => ok(x).id)).toEqual([r.pages[0]?.id ?? "", r.pages[0]?.id ?? ""]);
    expect(r.pages).toHaveLength(1);
    expect(r.questions).toHaveLength(2);
    expect(r.threads).toHaveLength(2);
  });

  test("M2: a released question that no longer stands is taken back on the rerun", async () => {
    const { run } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        const { ops } = yield* twoItems;
        yield* holdBack([ops], 1);
        const first = ok(yield* runDayEnd());
        yield* query((d) =>
          d.update(workItems).set({ status: "done" }).where(eq(workItems.id, ops)),
        );
        const second = ok(yield* runDayEnd());
        const [q] = yield* questionsOf;
        const said = yield* query((d) =>
          d
            .select()
            .from(inboxMessages)
            .where(eq(inboxMessages.inboxItemId, q?.inboxItemId ?? ""))
            .all(),
        );
        return { first, second, q, said };
      }),
    );
    expect(r.first.questions).toHaveLength(1);
    expect(r.second.questions).toEqual([]);
    expect(r.q).toMatchObject({ status: "rejected", result: { settled: true, withdrawn: true } });
    expect(JSON.stringify(r.said.at(-1)?.content)).toContain("No longer needed");
  });

  test("L1: a re-ask after an answer that matched no choice stays released and is listed", async () => {
    const { run } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        const { cert, ops } = yield* twoItems;
        yield* askQuestions({
          attach: [],
          meaning: [],
          doubts: [{ reason: "items", itemIds: [cert, ops] }],
          perDay: 0,
          dayStart: dayStart(),
        });
        const first = ok(yield* runDayEnd());
        const [row] = yield* questionsOf;
        if (!row) throw new Error("no question");
        // As Intake.reply does: the answer settles it, then the work model reads it.
        yield* query((d) =>
          d.update(proposals).set({ status: "executed" }).where(eq(proposals.id, row.id)),
        );
        const answer = yield* answerWorkQuestion(row, "maybe later");
        const second = ok(yield* runDayEnd());
        const page = yield* dayEndItem(localDate());
        return { first, answer, second, page, all: yield* questionsOf };
      }),
    );
    expect(r.answer.reask).toBe(true);
    const reask = r.all.find((p) => p.status === "pending");
    expect((reask?.payload as { releasedOn?: string } | undefined)?.releasedOn).toBe(localDate());
    expect(r.second.questions).toHaveLength(1);
    expect(r.second.released).toBe(0);
    expect(r.second.questions[0]?.question).toContain("one piece of work?");
    expect(dayEndOf(r.page?.triage)?.questionIds).toEqual([reask?.id ?? ""]);
  });

  test("L2: five released a day, answered or not", async () => {
    const { run } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        const ids = yield* sevenItems;
        yield* holdBack(ids, 7);
        const first = ok(yield* runDayEnd());
        yield* query((d) =>
          d
            .update(proposals)
            .set({ status: "executed", result: { answer: "ok" } })
            .where(eq(proposals.kind, "needs_clarification")),
        );
        const second = ok(yield* runDayEnd());
        return { first, second, left: yield* unaskedOf(localDate()) };
      }),
    );
    expect(r.first.released).toBe(5);
    expect(r.second.released).toBe(0);
    expect(r.second.questions).toEqual([]);
    expect(r.left).toHaveLength(2);
  });

  test("L5: a question held back while its thread is parked is released once it is back", async () => {
    const { run } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        const { ops } = yield* twoItems;
        const thread = yield* workThread(ops, "Rotate");
        yield* query((d) =>
          d.update(inboxItems).set({ status: "parked" }).where(eq(inboxItems.id, thread)),
        );
        const asked = yield* askQuestions({
          attach: [],
          meaning: [{ itemId: ops, question: "Prod only?", choices: [] }],
          doubts: [],
          perDay: 5,
          dayStart: dayStart(),
        });
        const kept = yield* unaskedOf(localDate());
        yield* query((d) =>
          d.update(inboxItems).set({ status: "triaged" }).where(eq(inboxItems.id, thread)),
        );
        const end = ok(yield* runDayEnd());
        return { asked, kept, end };
      }),
    );
    expect(r.asked).toEqual([]);
    expect(r.kept).toHaveLength(1);
    expect(r.end.released).toBe(1);
  });

  test("L5: the day's list keeps the newest fifty", async () => {
    const { run } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        const { cert, ops } = yield* twoItems;
        yield* askQuestions({
          attach: Array.from({ length: 60 }, (_, i) => ({
            eventId: `e${String(i).padStart(2, "0")}`,
            itemIds: [cert, ops],
            inboxItemId: null,
            datesNamed: false,
            summary: `Event ${i}`,
            text: "",
          })),
          meaning: [],
          doubts: [],
          perDay: 0,
          dayStart: dayStart(),
        });
        return yield* unaskedOf(localDate());
      }),
    );
    expect(r).toHaveLength(UNASKED_LIMIT);
    expect(r[0]).toMatchObject({ type: "attach", ask: { eventId: "e10" } });
  });
});

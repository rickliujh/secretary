/**
 * The intake run at the service level (FR-21, D68): items written as they are
 * decided, with the proposals the end-of-turn merge gave; a stop keeps them and
 * a resume reads only the rest; Edit takes the message back; a timed-out call is
 * retried, and a third timeout fails its item only.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Exit } from "effect";
import { inboxItems, llmCalls } from "@/db/schema";
import { type ItemOutput, type ItemSnapshot, mapItemOutput } from "@/prompts/classify";
import { query } from "@/services/db";
import type { Scripted } from "@/services/llm/test";
import { readThread, TODAY } from "@/test/helpers";
import { intakeTestLayer, out } from "@/test/intake-layer";
import { syncOnce } from "@/test/seed";
import { Intake, type RunEvent } from ".";
import { mergeItemProposals } from "./merge";
import { runRecordOf } from "./record";

const e = { rationale: "because", evidence: "from the notes", confidence: 0.7 };

const quote1 =
  "First: we need a new task in PAY to backfill refund totals for August, it should sit under the billing migration epic.";
const quote2 =
  "Second: OPS needs a task to rotate the ledger TLS certificate; Tom will pick it up.";
const long = [
  "Meeting notes from the payments sync, 24 September.",
  quote1,
  ...Array.from({ length: 8 }, (_, i) => `Discussion point ${i + 1} with no action.`),
  quote2,
  "Nothing else.",
].join("\n");

const split = out({
  items: [
    { quote: quote1, topic: "refunds" },
    { quote: quote2, topic: "certificate" },
  ],
});

const create = (projectKey: string, summary: string, ref = "$new:1") => ({
  kind: "create_issue",
  ref,
  projectKey,
  issueType: projectKey === "PAY" ? "Story" : "Task",
  summary,
  description: null,
  parent: null,
  epic: null,
  priority: null,
  assignee: null,
  dueDate: null,
  ...e,
});
const comment = (target: string, body: string, confidence = 0.7) => ({
  kind: "add_comment",
  target,
  body,
  ...e,
  confidence,
});
const answer = (summary: string, ...proposals: Record<string, unknown>[]) =>
  out({ summary, question: null, confidence: 0.9, proposals });

const refunds = "Backfill August refund totals";
const item1 = answer(
  "Refunds task",
  create("PAY", refunds),
  comment("$new:1", "Finance signed off.", 0.6),
);
// The same create (collapses into item 1's), a create of its own ($new:2 in the
// turn), a comment on each: the one on the refunds task repeats item 1's, more sure.
const item2 = answer(
  "Certificate task",
  create("PAY", refunds),
  create("OPS", "Rotate ledger TLS certificate", "$new:2"),
  comment("$new:2", "Tom will pick this up."),
  comment("$new:1", "Finance signed off.", 0.95),
);
const lone2 = answer("Certificate task", create("OPS", "Rotate ledger TLS certificate"));
const hang: Scripted = { hang: true };

const run = <A, E>(
  layer: ReturnType<typeof intakeTestLayer>["layer"],
  program: Effect.Effect<
    A,
    E,
    Intake | import("@/services/db").Db | import("@/services/sync").Sync
  >,
) => Effect.runPromise(Effect.provide(program, layer));

/** A triage of the long notes, with its events; `stopWhen` aborts the run. */
const triageWith = (events: RunEvent[], stopWhen?: (e: RunEvent) => boolean) =>
  Effect.gen(function* () {
    yield* syncOnce;
    const controller = new AbortController();
    const intake = yield* Intake;
    const exit = yield* Effect.promise(() =>
      Effect.runPromiseExit(
        intake.triage({
          text: long,
          source: "email",
          senderPersonId: null,
          today: TODAY,
          onEvent: (ev) => {
            events.push(ev);
            // Once the call is under way.
            if (stopWhen?.(ev)) setTimeout(() => controller.abort(), 30);
          },
        }),
        { signal: controller.signal },
      ),
    );
    const stored = events.find((ev) => ev.type === "stored");
    const inboxItemId = stored?.type === "stored" ? stored.inboxItemId : "";
    return { exit, inboxItemId, intake };
  });

/** What the end-of-turn merge made of the stored items' answers: the old behaviour. */
const endOfTurn = (items: { idx: number; quote: string; output: unknown; snapshot: unknown }[]) =>
  mergeItemProposals(
    [...items]
      .sort((a, b) => a.idx - b.idx)
      .map((i) => mapItemOutput(i.output as ItemOutput, i.quote, i.snapshot as ItemSnapshot)),
  );

const shape = (p: { payload: unknown; rationale: string | null; confidence: number | null }) =>
  JSON.stringify([p.payload, p.rationale, p.confidence]);

describe("the intake run (D68)", () => {
  test("a two-item turn written item by item gives the end-of-turn merge's proposals", async () => {
    const { layer } = intakeTestLayer({ "fast-m": [split], "std-m": [item1, item2] });
    const events: RunEvent[] = [];
    const r = await run(
      layer,
      Effect.gen(function* () {
        const { exit, inboxItemId } = yield* triageWith(events);
        return { exit, ...(yield* readThread(inboxItemId)) };
      }),
    );
    expect(Exit.isSuccess(r.exit)).toBe(true);
    const expected = endOfTurn(r.items);
    const itemOf = new Map(r.items.map((i) => [i.idx, i.id]));
    // The same proposals, each from the same item, with the more confident reasons.
    expect(r.props.map(shape).sort()).toEqual(
      expected.map((m) => shape({ ...m, payload: m.payload })).sort(),
    );
    expect(r.props.map((p) => [p.intakeItemId, JSON.stringify(p.payload)]).sort()).toEqual(
      expected.map((m) => [itemOf.get(m.itemIndex), JSON.stringify(m.payload)]).sort() as never,
    );
    // $new numbering runs across the items; the repeated create and comment collapsed.
    expect(r.props.map((p) => p.payload)).toMatchObject([
      { kind: "create_issue", ref: "$new:1", projectKey: "PAY" },
      { kind: "add_comment", target: "$new:1", bodyMd: "Finance signed off." },
      { kind: "create_issue", ref: "$new:2", projectKey: "OPS" },
      { kind: "add_comment", target: "$new:2" },
    ]);
    expect(r.props[1]?.confidence).toBe(0.95);
    // One answer for the turn, its summary of both items.
    expect(r.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(r.messages[1]?.content).toEqual({ summary: "Refunds task; Certificate task" });
    expect(r.item?.triage).toMatchObject({ items: 2, proposals: 4, questions: 0 });
    // The events: stored, split, lookups, each item decided with its cards, the answer.
    const kinds = events.map((ev) =>
      ev.type === "step"
        ? `${ev.name}:${ev.phase}${ev.item === undefined ? "" : `:${ev.item}`}`
        : ev.type === "item_done"
          ? `done:${ev.item}:${ev.cards}`
          : ev.type,
    );
    expect(kinds.filter((k) => k !== "attempt")).toEqual([
      "stored",
      "split:start",
      "split:end",
      "lookup:start",
      "lookup:end",
      "decide:start:0",
      "decide:end:0",
      "done:0:2",
      "decide:start:1",
      "decide:end:1",
      "done:1:2",
      "write:start",
      "write:end",
    ]);
  });

  test("a stop after item 1 keeps its cards; a resume decides only item 2", async () => {
    const { layer, models } = intakeTestLayer(
      { "fast-m": [split], "std-m": [item1, hang, lone2] },
      [],
      { llm: { timeoutMs: 5_000 } },
    );
    const events: RunEvent[] = [];
    const r = await run(
      layer,
      Effect.gen(function* () {
        const { exit, inboxItemId, intake } = yield* triageWith(
          events,
          (ev) => ev.type === "attempt" && ev.item === 1,
        );
        const stopped = yield* readThread(inboxItemId);
        const resumed: RunEvent[] = [];
        const res = yield* intake.resume(inboxItemId, { onEvent: (ev) => resumed.push(ev) });
        return { exit, stopped, res, resumed, after: yield* readThread(inboxItemId) };
      }),
    );
    expect(Exit.isInterrupted(r.exit)).toBe(true);
    // Item 1's cards are written; the record says item 2 is left.
    expect(r.stopped.props.map((p) => p.kind)).toEqual(["create_issue", "add_comment"]);
    const record = runRecordOf(r.stopped.item?.triage);
    expect(record).toMatchObject({ state: "stopped", decided: 1, cards: 2 });
    expect(record?.undecided.map((j) => [j.pos, j.quote])).toEqual([[1, quote2]]);
    // The resume reads item 2 alone, into the same answer.
    expect(r.res).toMatchObject({ items: 1, proposals: 1 });
    expect(models.calls.map((c) => c.model)).toEqual(["fast-m", "std-m", "std-m", "std-m"]);
    expect(r.after.props.map((p) => p.payload)).toMatchObject([
      { kind: "create_issue", ref: "$new:1", projectKey: "PAY" },
      { kind: "add_comment", target: "$new:1" },
      { kind: "create_issue", ref: "$new:2", projectKey: "OPS" },
    ]);
    expect(r.after.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(new Set(r.after.props.map((p) => p.messageId)).size).toBe(1);
    expect(r.after.item?.triage).toMatchObject({ items: 1, proposals: 1 });
    expect(runRecordOf(r.after.item?.triage)).toBeNull();
    // Resumed events keep the item's place in the turn.
    expect(r.resumed.find((ev) => ev.type === "item_done")).toMatchObject({ item: 1, count: 2 });
  });

  test("Edit withdraws the message and the thread that held nothing else", async () => {
    const { layer } = intakeTestLayer({ "fast-m": [split], "std-m": [item1, hang] }, [], {
      llm: { timeoutMs: 5_000 },
    });
    const r = await run(
      layer,
      Effect.gen(function* () {
        const events: RunEvent[] = [];
        const { inboxItemId, intake } = yield* triageWith(
          events,
          (ev) => ev.type === "attempt" && ev.item === 1,
        );
        const stored = events.find((ev) => ev.type === "stored");
        const messageId = stored?.type === "stored" ? (stored.messageId ?? "") : "";
        const withdrawn = yield* intake.withdraw(messageId);
        const left = yield* query((d) =>
          d.select().from(inboxItems).where(eq(inboxItems.id, inboxItemId)).all(),
        );
        return { withdrawn, left, after: yield* readThread(inboxItemId) };
      }),
    );
    expect(r.withdrawn).toMatchObject({ thread: true });
    expect(r.left).toHaveLength(0);
    expect(r.after.props).toHaveLength(0);
    expect(r.after.items).toHaveLength(0);
  });

  test("Edit of a reply takes back its cards and puts back what it replaced", async () => {
    const short = "Please make a PAY task to backfill August refund totals.";
    const { layer } = intakeTestLayer(
      {
        "std-m": [
          answer("Refunds task", create("PAY", refunds)),
          answer("Refunds task", { ...create("PAY", refunds), priority: "High" }),
        ],
      },
      [],
    );
    const r = await run(
      layer,
      Effect.gen(function* () {
        yield* syncOnce;
        const intake = yield* Intake;
        const first = yield* intake.triage({
          text: short,
          source: "typed",
          senderPersonId: null,
          today: TODAY,
        });
        const before = yield* readThread(first.inboxItemId);
        const events: RunEvent[] = [];
        yield* intake.reply({
          inboxItemId: first.inboxItemId,
          parts: [{ type: "typed", text: "priority High" }],
          onEvent: (ev) => events.push(ev),
        });
        const stored = events.find((ev) => ev.type === "stored");
        const messageId = stored?.type === "stored" ? (stored.messageId ?? "") : "";
        // A finished turn's message can be taken back too while its cards are undecided.
        const withdrawn = yield* intake.withdraw(messageId);
        return { before, withdrawn, after: yield* readThread(first.inboxItemId) };
      }),
    );
    expect(r.withdrawn).toMatchObject({ thread: false });
    expect(r.after.messages.map((m) => m.id)).toEqual(r.before.messages.map((m) => m.id));
    expect(r.after.props.map((p) => [p.id, p.status])).toEqual(
      r.before.props.map((p) => [p.id, "pending"]),
    );
  });

  test("two timed-out calls, then an answer: every card, three attempts recorded", async () => {
    const { layer } = intakeTestLayer(
      { "fast-m": [split], "std-m": [item1, hang, hang, item2] },
      [],
      { llm: { timeoutMs: 60, pausesMs: [10, 10] } },
    );
    const events: RunEvent[] = [];
    const r = await run(
      layer,
      Effect.gen(function* () {
        const { exit, inboxItemId } = yield* triageWith(events);
        const calls = yield* query((d) => d.select().from(llmCalls).all());
        return { exit, calls, ...(yield* readThread(inboxItemId)) };
      }),
    );
    expect(Exit.isSuccess(r.exit)).toBe(true);
    expect(r.props).toHaveLength(4);
    expect(
      r.calls.filter((c) => c.task === "classify_item").map((c) => [c.ok, c.errorKind]),
    ).toEqual([
      [true, null],
      [false, "timeout"],
      [false, "timeout"],
      [true, null],
    ]);
    const attempts = events.flatMap((ev) =>
      ev.type === "attempt" && ev.item === 1 ? [[ev.attempt.number, ev.attempt.reason]] : [],
    );
    expect(attempts).toEqual([
      [1, null],
      [2, "timeout"],
      [3, "timeout"],
    ]);
  });

  test("a timed-out third attempt fails that item only; the fast tier reads it again", async () => {
    const { layer, models } = intakeTestLayer(
      { "fast-m": [split, item1], "std-m": [hang, hang, hang, lone2] },
      [],
      { llm: { timeoutMs: 60, pausesMs: [10, 10] } },
    );
    const events: RunEvent[] = [];
    const r = await run(
      layer,
      Effect.gen(function* () {
        const { exit, inboxItemId, intake } = yield* triageWith(events);
        const failed = yield* readThread(inboxItemId);
        const res = yield* intake.resume(inboxItemId, { tier: "fast" });
        return { exit, failed, res, after: yield* readThread(inboxItemId) };
      }),
    );
    expect(Exit.isFailure(r.exit)).toBe(true);
    expect(events.find((ev) => ev.type === "item_failed")).toMatchObject({
      item: 0,
      kind: "timeout",
    });
    // Item 2 was read after item 1 failed; its card is kept.
    expect(r.failed.props.map((p) => p.payload)).toMatchObject([
      { kind: "create_issue", projectKey: "OPS" },
    ]);
    const record = runRecordOf(r.failed.item?.triage);
    expect(record).toMatchObject({ state: "failed", failed: [0] });
    expect(record?.undecided.map((j) => j.pos)).toEqual([0]);
    expect(String((r.failed.item?.triage as { error?: string } | undefined)?.error)).toContain(
      "No response within",
    );
    // Fast tier: item 1 on fast-m, after the split.
    expect(models.calls.map((c) => c.model)).toEqual([
      "fast-m",
      "std-m",
      "std-m",
      "std-m",
      "std-m",
      "fast-m",
    ]);
    expect(r.after.props.map((p) => p.payload)).toMatchObject([
      { kind: "create_issue", projectKey: "OPS", ref: "$new:1" },
      { kind: "create_issue", projectKey: "PAY", ref: "$new:2" },
      { kind: "add_comment", target: "$new:2" },
    ]);
  });

  test("a turn in flight at quit is stopped at the next start", async () => {
    const { layer } = intakeTestLayer({ "fast-m": [split], "std-m": [item1, hang] }, [], {
      llm: { timeoutMs: 5_000 },
    });
    const r = await run(
      layer,
      Effect.gen(function* () {
        const { inboxItemId, intake } = yield* triageWith(
          [],
          (ev) => ev.type === "attempt" && ev.item === 1,
        );
        // As if the app quit mid-run: the record still says running.
        const item = yield* query((d) =>
          d.select().from(inboxItems).where(eq(inboxItems.id, inboxItemId)).get(),
        );
        const record = runRecordOf(item?.triage);
        yield* query((d) =>
          d
            .update(inboxItems)
            .set({ triage: { run: { ...record, state: "running" } } })
            .where(eq(inboxItems.id, inboxItemId)),
        );
        const n = yield* intake.recoverRuns;
        const after = yield* readThread(inboxItemId);
        return { n, record: runRecordOf(after.item?.triage) };
      }),
    );
    expect(r.n).toBe(1);
    expect(r.record?.state).toBe("stopped");
  });
});

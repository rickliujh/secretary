/**
 * Cards on the note's blocks (FR-20.7, D67) on the database: the page's
 * queries, the strip's badge, and Ask on a block. Real DailyNote, Intake and
 * Llm over the fixtures; the models are scripted.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Either } from "effect";
import { dailyNoteBlocks, dailyNotes, inboxItems, proposals, workItems } from "@/db/schema";
import { localDate } from "@/lib/dates";
import { newId, nowIso } from "@/lib/ids";
import type { Scripted } from "@/services/llm/test";
import { readThread } from "@/test/helpers";
import { intakeTestLayer, out } from "@/test/intake-layer";
import { syncOnce } from "@/test/seed";
import { query } from "../db";
import { DailyNote, type DailyNoteShape } from ".";
import { hashText, normaliseBlock, splitBlocks } from "./blocks";
import { blocksOf, cardCount, stripBadge, type ThreadSummary, threadSummaries } from "./cards";
import { dayBefore, recordBlock, saveBody } from "./queries";

const home = {
  smallAsks: {
    projectKey: "OPS",
    label: "small-ask",
    joinActiveSprint: true,
    hintDismissed: false,
    defaultPoints: null,
  },
};
const ask = (summary: string) => ({
  summary,
  question: null,
  confidence: 0.9,
  proposals: [
    {
      kind: "create_issue",
      ref: "$new:1",
      smallAsk: "yes",
      summary,
      description: "",
      dueDate: "",
      issueType: "",
      rationale: "A to-do in the note",
      evidence: summary,
      confidence: 0.9,
    },
  ],
});
const triage = (...kinds: string[]) =>
  out({
    blocks: kinds.map((k, i) => ({
      index: String(i + 1),
      kind: k,
      item: "(none)",
      thread: "(none)",
    })),
  });

type Ctx = { note: DailyNoteShape; today: string };

async function withNote<A>(
  scripts: Record<string, Scripted[]>,
  body: (c: Ctx) => Effect.Effect<A, unknown, unknown>,
) {
  const { layer, models } = intakeTestLayer(scripts, [], { settings: home });
  const r = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        yield* syncOnce;
        const note = yield* DailyNote;
        return yield* body({ note, today: localDate() });
      }) as Effect.Effect<A, unknown, never>,
      layer,
    ),
  );
  return { r, models };
}

const hashOf = (text: string) => hashText(normaliseBlock(text));
const noteThreads = query((d) =>
  d.select().from(inboxItems).where(eq(inboxItems.source, "note")).all(),
);
const rowsOf = query((d) => d.select().from(dailyNoteBlocks).all());
const calls = (c: readonly { model: string }[], model: string) =>
  c.filter((x) => x.model === model).length;

const summary = (over: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id: "t",
  status: "triaged",
  summary: "Send Dana the numbers",
  error: null,
  waiting: 0,
  questions: 0,
  approved: 0,
  failed: 0,
  created: [],
  ...over,
});

describe("the strip's badge (D67)", () => {
  test("what waits first, else how the thread ended", () => {
    expect(stripBadge(summary({ waiting: 1 }))).toBe("1 card waiting");
    expect(stripBadge(summary({ waiting: 2 }))).toBe("2 cards waiting");
    expect(stripBadge(summary({ questions: 1 }))).toBe("1 question");
    expect(stripBadge(summary({ waiting: 2, questions: 3 }))).toBe("2 cards waiting, 3 questions");
    expect(stripBadge(summary({ approved: 2, waiting: 1 }))).toBe("1 card waiting");
    expect(stripBadge(summary({ approved: 2 }))).toBe("approved");
    expect(stripBadge(summary({ status: "dismissed", waiting: 1 }))).toBe("dismissed");
    expect(stripBadge(summary())).toBe("nothing left");
    expect(stripBadge(summary({ error: "Provider down" }))).toBe("did not go through");
    expect(stripBadge(summary({ approved: 1, failed: 1 }))).toBe("1 failed");
  });
});

describe("the page's queries (D67)", () => {
  test("blocksOf gives the day's rows with the work item's name; threadSummaries counts", async () => {
    const { r } = await withNote(
      { "fast-m": [triage("act", "skip")], "std-m": [out(ask("Send Dana the Q3 numbers"))] },
      ({ note, today }) =>
        Effect.gen(function* () {
          yield* note.save(today, "- [ ] send Dana the Q3 numbers\n\nLunch with Mia\n");
          yield* note.read("button");
          const itemId = newId();
          const now = nowIso();
          yield* query((d) =>
            d.insert(workItems).values({ id: itemId, name: "Payments cert", createdAt: now }),
          );
          yield* recordBlock(
            today,
            { hash: "ctx", text: "cert is Friday", section: null, position: 9 },
            "context",
            { workItemId: itemId },
          );
          const rows = yield* blocksOf(today);
          const thread = rows.find((b) => b.status === "acted")?.inboxItemId ?? "";
          const before = yield* threadSummaries([thread, thread]);
          // Approved and executed: the strip says approved and lists the ticket.
          yield* query((d) =>
            d
              .update(proposals)
              .set({ status: "executed", decidedAt: now, result: { issueKey: "OPS-77" } })
              .where(eq(proposals.inboxItemId, thread)),
          );
          const after = yield* threadSummaries([thread]);
          return { rows, before, after, none: yield* threadSummaries([]) };
        }),
    );
    expect(
      r.rows
        .map((b) => [b.status, !!b.inboxItemId, b.workItemName])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ).toEqual([
      ["acted", true, null],
      ["context", false, "Payments cert"],
      ["skipped", false, null],
    ]);
    expect(r.before).toHaveLength(1);
    expect(r.before[0]).toMatchObject({ waiting: 1, questions: 0, approved: 0, created: [] });
    expect(stripBadge(r.before[0] as ThreadSummary)).toBe("1 card waiting");
    expect(r.after[0]).toMatchObject({ waiting: 0, approved: 1, created: ["OPS-77"] });
    expect(stripBadge(r.after[0] as ThreadSummary)).toBe("approved");
    expect(r.none).toEqual([]);
  });
});

describe("Ask the secretary about this (D67)", () => {
  test("on a block the reading left alone: a new thread, recorded acted; an edit revises it", async () => {
    const { r, models } = await withNote(
      {
        "fast-m": [triage("skip")],
        "std-m": [out(ask("Book the room")), out(ask("Book the big room"))],
      },
      ({ note, today }) =>
        Effect.gen(function* () {
          yield* note.save(today, "book the room for Friday\n");
          const read = yield* note.read("button");
          const asked = yield* note.ask(today, hashOf("book the room for Friday"));
          // Asking again opens the same thread; nothing is sent.
          const again = yield* note.ask(today, hashOf("book the room for Friday"));
          yield* note.save(today, "book the big room for Friday\n");
          const edit = yield* note.read("typing");
          const threads = yield* noteThreads;
          return {
            read,
            asked,
            again,
            edit,
            threads,
            thread: yield* readThread(asked.inboxItemId),
            rows: yield* rowsOf,
          };
        }),
    );
    expect(r.read).toMatchObject({ skippedBlocks: 1, cards: 0 });
    expect(r.again.inboxItemId).toBe(r.asked.inboxItemId);
    expect(r.edit).toMatchObject({ revised: 1, cards: 0, called: false });
    expect(r.threads.map((t) => t.id)).toEqual([r.asked.inboxItemId]);
    expect(calls(models.calls, "fast-m")).toBe(1);
    expect(calls(models.calls, "std-m")).toBe(2);
    expect(r.thread.messages[0]?.content).toMatchObject({
      source: "note",
      parts: [{ type: "typed", text: "book the room for Friday" }],
    });
    expect(r.thread.messages[2]?.content).toMatchObject({
      parts: [
        { type: "typed", text: "The note now says: " },
        { type: "pasted", text: "book the big room for Friday" },
      ],
    });
    expect(r.rows.map((b) => [b.text, b.status]).sort()).toEqual([
      ["book the big room for Friday", "acted"],
      ["book the room for Friday", "revised"],
    ]);
  });

  test("on a changed block the reading has not seen: it revises the block's thread", async () => {
    const { r, models } = await withNote(
      {
        "fast-m": [triage("act")],
        "std-m": [
          out(ask("Send Dana the Q3 numbers")),
          out(ask("Send Dana the Q3 and Q4 numbers")),
        ],
      },
      ({ note, today }) =>
        Effect.gen(function* () {
          yield* note.save(today, "- [ ] send Dana the Q3 numbers\n");
          yield* note.read("button");
          const first = (yield* noteThreads)[0]?.id ?? "";
          yield* note.save(today, "- [ ] send Dana the Q3 and Q4 numbers\n");
          const asked = yield* note.ask(today, hashOf("- [ ] send Dana the Q3 and Q4 numbers"));
          const later = yield* note.read("pass");
          return { first, asked, later, threads: yield* noteThreads };
        }),
    );
    expect(r.asked.inboxItemId).toBe(r.first);
    expect(r.threads).toHaveLength(1);
    expect(r.later).toMatchObject({ revised: 0, cards: 0, called: false });
    expect(calls(models.calls, "fast-m")).toBe(1);
  });

  test("a private block offers no Ask; a block no longer in the note is not found", async () => {
    const { r, models } = await withNote({}, ({ note, today }) =>
      Effect.gen(function* () {
        yield* note.save(today, "## Private\nsalary talk with HR\n\n## Work\nplain line\n");
        const priv = yield* Effect.either(note.ask(today, hashOf("salary talk with HR")));
        const gone = yield* Effect.either(note.ask(today, hashOf("never written")));
        return { priv, gone, rows: yield* rowsOf };
      }),
    );
    expect(Either.isLeft(r.priv) && r.priv.left).toMatchObject({
      _tag: "NoteError",
      kind: "private",
    });
    expect(Either.isLeft(r.gone) && r.gone.left).toMatchObject({
      _tag: "NoteError",
      kind: "not_found",
    });
    expect(models.calls).toHaveLength(0);
    expect(r.rows).toHaveLength(0);
  });

  test("on an earlier day's block: a thread on that day's block", async () => {
    const { r } = await withNote({ "std-m": [out(ask("Call the bank"))] }, ({ note, today }) =>
      Effect.gen(function* () {
        const earlier = "2020-01-02";
        yield* query((d) =>
          d
            .insert(dailyNotes)
            .values({ date: earlier, body: "call the bank\n", updatedAt: nowIso() }),
        );
        const block = splitBlocks("call the bank\n")[0];
        const asked = yield* note.ask(earlier, block?.hash ?? "");
        return { asked, today, rows: yield* rowsOf };
      }),
    );
    expect(r.asked.inboxItemId).toBeTruthy();
    expect(r.rows.map((b) => [b.date, b.status, b.inboxItemId])).toEqual([
      ["2020-01-02", "acted", r.asked.inboxItemId],
    ]);
  });
});

describe("Ask's routing and turns (D67)", () => {
  test("clicked twice at once: one thread, one send", async () => {
    const { r, models } = await withNote(
      { "std-m": [out(ask("Call the bank"))] },
      ({ note, today }) =>
        Effect.gen(function* () {
          yield* note.save(today, "call the bank\n");
          const hash = hashOf("call the bank");
          const [a, b] = yield* Effect.all([note.ask(today, hash), note.ask(today, hash)], {
            concurrency: "unbounded",
          });
          return { a, b, threads: yield* noteThreads };
        }),
    );
    expect(r.a.inboxItemId).toBe(r.b.inboxItemId);
    expect(r.threads).toHaveLength(1);
    expect(calls(models.calls, "std-m")).toBe(1);
  });

  test("racing a reading: one thread, the block sent once", async () => {
    const { r, models } = await withNote(
      { "fast-m": [triage("act")], "std-m": [out(ask("Call the bank"))] },
      ({ note, today }) =>
        Effect.gen(function* () {
          yield* note.save(today, "call the bank\n");
          const [, asked] = yield* Effect.all(
            [note.read("button"), note.ask(today, hashOf("call the bank"))],
            { concurrency: "unbounded" },
          );
          return { asked, threads: yield* noteThreads, rows: yield* rowsOf };
        }),
    );
    expect(r.threads.map((t) => t.id)).toEqual([r.asked.inboxItemId]);
    expect(calls(models.calls, "std-m")).toBe(1);
    expect(r.rows.map((b) => [b.status, b.inboxItemId])).toEqual([["acted", r.asked.inboxItemId]]);
  });

  test("carried over from yesterday's block with a conversation: that thread, no call", async () => {
    const { r } = await withNote(
      { "fast-m": [triage("act")], "std-m": [out(ask("Call the bank"))] },
      ({ note, today }) =>
        Effect.gen(function* () {
          yield* saveBody(dayBefore(today), "call the bank\n");
          yield* note.read("button");
          const first = (yield* noteThreads)[0]?.id;
          yield* note.save(today, "call the bank\n");
          const asked = yield* note.ask(today, hashOf("call the bank"));
          return { first, asked, rows: yield* rowsOf };
        }),
    );
    expect(r.asked.inboxItemId).toBe(r.first ?? "");
    expect(r.rows.filter((b) => b.inboxItemId === r.first && b.status === "acted")).toHaveLength(2);
  });

  test("naming a ticket a note thread made: a new message in that thread", async () => {
    const { r, models } = await withNote(
      {
        "fast-m": [triage("act")],
        "std-m": [out(ask("Send Dana the Q3 numbers")), out(ask("Chase Dana on OPS-77"))],
      },
      ({ note, today }) =>
        Effect.gen(function* () {
          yield* note.save(today, "- [ ] send Dana the Q3 numbers\n");
          yield* note.read("button");
          const thread = (yield* noteThreads)[0]?.id ?? "";
          yield* query((d) =>
            d
              .update(proposals)
              .set({ status: "executed", decidedAt: nowIso(), result: { issueKey: "OPS-77" } })
              .where(eq(proposals.inboxItemId, thread)),
          );
          yield* note.save(today, "- [ ] send Dana the Q3 numbers\n\nchase Dana on OPS-77\n");
          const asked = yield* note.ask(today, hashOf("chase Dana on OPS-77"));
          return { thread, asked, threads: yield* noteThreads, t: yield* readThread(thread) };
        }),
    );
    expect(r.asked.inboxItemId).toBe(r.thread);
    expect(r.threads).toHaveLength(1);
    expect(calls(models.calls, "fast-m")).toBe(1);
    const users = r.t.messages.filter((m) => m.role === "user");
    expect(users).toHaveLength(2);
    expect(users[1]?.content).toMatchObject({ asInput: true });
  });
});

describe("cards waiting (D67)", () => {
  test("a playbook bundle's steps are one card", () => {
    expect(
      cardCount([{ bundleId: "b1" }, { bundleId: "b1" }, { bundleId: null }, { bundleId: "b2" }]),
    ).toBe(3);
  });
});

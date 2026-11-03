import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { hashText, normaliseBlock } from "@/services/note/blocks";
import type { BlockCard, ThreadSummary } from "@/services/note/cards";
import { blockAtLine, blockMarks, emptyCards, type NoteCardsData, sameMark } from "./block-marks";
import { NoteCardStore } from "./card-store";
import { markAtCursor, markFace, noteCardsField, setLit, setNoteCards } from "./cards-extension";

const h = (text: string) => hashText(normaliseBlock(text));
const row = (text: string, over: Partial<BlockCard>): [string, BlockCard] => [
  h(text),
  {
    hash: h(text),
    status: "skipped",
    inboxItemId: null,
    workItemId: null,
    workItemName: null,
    ...over,
  },
];
const summary = (over: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id: "t1",
  status: "triaged",
  summary: "Send Dana the numbers",
  error: null,
  waiting: 1,
  questions: 0,
  approved: 0,
  failed: 0,
  created: [],
  ...over,
});

const NOTE = `# Today

- [ ] send Dana the Q3 numbers
  by Friday

cert is Friday

lunch with Mia

new line not read

## Private
salary talk
`;

const data: NoteCardsData = {
  privateHeading: "Private",
  rows: new Map([
    row("- [ ] send Dana the Q3 numbers\nby Friday", { status: "acted", inboxItemId: "t1" }),
    row("cert is Friday", { status: "context", workItemId: "w1", workItemName: "Cert" }),
    row("lunch with Mia", { status: "skipped" }),
  ]),
  threads: new Map([["t1", summary()]]),
  reads: true,
};

describe("blockMarks (D67)", () => {
  test("a mark per block: count, noted, left alone, not read yet, private", () => {
    const { marks } = blockMarks(NOTE, data);
    expect(marks.map((m) => [m.line, m.toLine, m.state.kind])).toEqual([
      [2, 3, "waiting"],
      [5, 5, "noted"],
      [7, 7, "alone"],
      [9, 9, "unread"],
      [12, 12, "private"],
    ]);
    expect(marks[0]?.state).toEqual({ kind: "waiting", count: 1, questions: 0 });
    expect(marks[0]?.thread).toBe("t1");
    expect(marks[4]?.private).toBe(true);
  });

  test("without a reading to come, a new block is not read (Ask only); a thread loading shows quiet", () => {
    const { marks } = blockMarks(NOTE, { ...data, reads: false, threads: new Map() });
    expect(marks.map((m) => m.state.kind)).toEqual([
      "loading",
      "noted",
      "alone",
      "not_read",
      "private",
    ]);
  });

  test("a recorded block moved under the private heading is private", () => {
    const moved = `## Private\nlunch with Mia\n`;
    expect(blockMarks(moved, data).marks).toMatchObject([
      { private: true, thread: null, state: { kind: "private" } },
    ]);
  });

  test("a paragraph typed at a block's start does not take its key, row or thread", () => {
    const text = "cert is Friday\n\n- [ ] send Dana the Q3 numbers\n  by Friday\n";
    const first = blockMarks(text, data);
    const at = text.indexOf("- [ ]");
    const typed = "x\n\n";
    const edited = `${text.slice(0, at)}${typed}${text.slice(at)}`;
    // As the editor maps the ranges: a block's start stays before text inserted there.
    const carries = first.carries.map((c) => ({
      ...c,
      from: c.from > at ? c.from + typed.length : c.from,
      to: c.to >= at ? c.to + typed.length : c.to,
    }));
    const { marks } = blockMarks(edited, data, carries);
    expect(marks.map((m) => [m.hash === h("x"), m.thread, m.changed, m.state.kind])).toEqual([
      [false, null, false, "noted"],
      [true, null, false, "unread"],
      [false, "t1", false, "waiting"],
    ]);
    expect(marks[2]?.key).toBe(first.marks[1]?.key);
    expect(marks[1]?.key).not.toBe(first.marks[1]?.key);
  });

  test("the same words twice are two keys", () => {
    const { marks } = blockMarks("same\n\nsame\n", emptyCards);
    expect(marks.map((m) => m.key)).toEqual([`${h("same")}#0`, `${h("same")}#1`]);
  });

  test("an edited block keeps its key and row, as changed and not read yet", () => {
    const first = blockMarks(NOTE, data);
    const at = NOTE.indexOf("by Friday") + "by Friday".length;
    const edited = `${NOTE.slice(0, at)} at noon${NOTE.slice(at)}`;
    // The editor maps the ranges; an insertion at a block's end stays inside it.
    const carries = first.carries.map((c) => ({
      ...c,
      from: c.from > at ? c.from + 8 : c.from,
      to: c.to >= at ? c.to + 8 : c.to,
    }));
    const { marks } = blockMarks(edited, data, carries);
    expect(marks[0]).toMatchObject({
      key: first.marks[0]?.key,
      changed: true,
      thread: "t1",
      state: { kind: "unread" },
    });
    expect(marks[0]?.hash).not.toBe(first.marks[0]?.hash);
    expect(marks.slice(1).map((m) => m.changed)).toEqual([false, false, false, false]);
  });

  test("the block under a line: the pointer's and the cursor's", () => {
    const { marks } = blockMarks(NOTE, data);
    expect(blockAtLine(marks, 3)?.line).toBe(2);
    expect(blockAtLine(marks, 0)).toBeNull();
    expect(blockAtLine(marks, 4)).toBeNull();
    expect(blockAtLine(marks, 12)?.state.kind).toBe("private");
  });

  test("a published mark is kept while only its lines move", () => {
    const a = blockMarks(NOTE, data).marks[0];
    const b = blockMarks(`x\n\n${NOTE}`, data).marks[1];
    if (!a || !b) throw new Error("no marks");
    expect(b.line).toBe(a.line + 2);
    expect(sameMark(a, b)).toBe(a);
    const approved = blockMarks(NOTE, {
      ...data,
      threads: new Map([["t1", summary({ waiting: 0, approved: 1 })]]),
    }).marks[0];
    if (!approved) throw new Error("no mark");
    expect(sameMark(a, approved)).toBe(approved);
  });
});

describe("the mark's face (D67)", () => {
  test("a count, ?, !, icons, a hollow dot, a faint dot", () => {
    expect(markFace({ kind: "waiting", count: 2, questions: 0 })).toMatchObject({
      look: "waiting",
      text: "2",
    });
    expect(markFace({ kind: "waiting", count: 12, questions: 0 }).text).toBe("9+");
    expect(markFace({ kind: "question", count: 1 })).toMatchObject({ look: "question", text: "?" });
    expect(markFace({ kind: "failed", turn: true, count: 0 })).toMatchObject({
      look: "failed",
      text: "!",
    });
    expect(markFace({ kind: "done", ended: "approved" }).icon).toContain("<svg");
    expect(markFace({ kind: "noted" }).look).toBe("noted");
    expect(markFace({ kind: "private" }).look).toBe("private");
    expect(markFace({ kind: "unread" })).toMatchObject({ look: "unread", text: "" });
    for (const kind of ["alone", "not_read", "loading"] as const)
      expect(markFace({ kind }).look).toBe("ghost");
  });
});

describe("the editor's marks and lit lines (D67)", () => {
  const markers = (state: EditorState, field: ReturnType<typeof noteCardsField>) => {
    const out: number[] = [];
    state.field(field).markers.between(0, state.doc.length, (from) => void out.push(from));
    return out;
  };
  const litLines = (state: EditorState) => {
    const out: number[] = [];
    for (const d of state.facet(EditorView.decorations))
      if (typeof d !== "function")
        d.between(0, state.doc.length, (from) => void out.push(state.doc.lineAt(from).number - 1));
    return out;
  };
  const make = () => {
    const field = noteCardsField(new NoteCardStore());
    const state = EditorState.create({
      doc: NOTE,
      extensions: [EditorState.lineSeparator.of("\n"), field],
    });
    return { field, state };
  };

  test("the page's data arrives by effect; the marks follow the text as it changes", () => {
    let { state, field } = make();
    // Before the data: every block has its mark, all not read.
    expect(state.field(field).marks.every((m) => m.state.kind === "not_read" || m.private)).toBe(
      true,
    );
    state = state.update({ effects: setNoteCards.of(data) }).state;
    const startOf = (n: number) => state.doc.line(n + 1).from;
    expect(markers(state, field)).toEqual([2, 5, 7, 9, 12].map(startOf));
    // A line typed above moves them; the text is kept byte for byte.
    state = state.update({ changes: { from: 0, insert: "first\r\n\r\n" } }).state;
    // The new line is a block of its own, not read yet.
    expect(markers(state, field)).toEqual([0, 4, 7, 9, 11, 14].map(startOf));
    expect(state.doc.toString()).toBe(`first\r\n\r\n${NOTE}`);
  });

  test("the lit block's lines get the hover class, and follow it when lines above change", () => {
    const made = make();
    const { field } = made;
    let state = made.state.update({ effects: setNoteCards.of(data) }).state;
    const key = state.field(field).marks[0]?.key ?? "";
    state = state.update({ effects: setLit.of([key]) }).state;
    expect(litLines(state)).toEqual([2, 3]);
    state = state.update({ changes: { from: 0, insert: "a\n\n" } }).state;
    expect(litLines(state)).toEqual([4, 5]);
    expect(state.field(field).marks[1]?.key).toBe(key);
    state = state.update({ effects: setLit.of([]) }).state;
    expect(litLines(state)).toEqual([]);
  });

  test("typing in a block with a conversation keeps its key until the rows change", () => {
    const made = make();
    const { field } = made;
    let state = made.state.update({ effects: setNoteCards.of(data) }).state;
    const before = state.field(field).marks[0];
    let at = NOTE.indexOf("by Friday") + "by Friday".length;
    for (const ch of " at noon") {
      state = state.update({ changes: { from: at, insert: ch } }).state;
      at++;
    }
    const after = state.field(field).marks[0];
    expect(after).toMatchObject({ key: before?.key, changed: true, thread: "t1" });
    // Typing at the start of a block keeps it too.
    const start = state.doc.line(3).from;
    state = state.update({ changes: { from: start, insert: "  " } }).state;
    expect(state.field(field).marks[0]).toMatchObject({ key: before?.key, changed: true });
    // The reading recorded the new words: its own row, no longer changed, same key.
    const words = state.doc.sliceString(start, state.doc.line(4).to);
    const read = new Map([...data.rows, row(words, { status: "acted", inboxItemId: "t1" })]);
    state = state.update({ effects: setNoteCards.of({ ...data, rows: read }) }).state;
    expect(state.field(field).marks[0]).toMatchObject({
      key: before?.key,
      changed: false,
      state: { kind: "waiting" },
    });
  });

  test("Mod-. finds the block whose lines hold the cursor", () => {
    const made = make();
    const state = made.state.update({
      effects: setNoteCards.of(data),
      selection: { anchor: NOTE.indexOf("by Friday") },
    }).state;
    expect(markAtCursor(state, state.field(made.field).marks)?.line).toBe(2);
    const onHeading = state.update({ selection: { anchor: 0 } }).state;
    expect(markAtCursor(onHeading, onHeading.field(made.field).marks)).toBeNull();
  });
});

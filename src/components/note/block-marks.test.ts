import { describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { hashText, normaliseBlock } from "@/services/note/blocks";
import type { BlockCard } from "@/services/note/cards";
import { blockMarks, emptyCards, type NoteCardsData } from "./block-marks";
import { markAtCursor, noteCardsField, SlotStore, setNoteCards } from "./cards-extension";

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
  waiting: new Set(["t1"]),
};

describe("blockMarks (D67)", () => {
  test("a mark per read block, an unread one for Ask, none for an unread private block", () => {
    const { marks } = blockMarks(NOTE, data);
    expect(marks.map((m) => [m.line, m.toLine, m.status, m.waits, m.strip])).toEqual([
      [2, 3, "acted", true, "thread"],
      [5, 5, "context", false, "context"],
      [7, 7, "skipped", false, null],
      [9, 9, "unread", false, null],
    ]);
    expect(marks[0]?.thread).toBe("t1");
  });

  test("a recorded block moved under the private heading offers no Ask", () => {
    const moved = `## Private\nlunch with Mia\n`;
    expect(blockMarks(moved, data).marks).toMatchObject([
      { status: "skipped", private: true, thread: null },
    ]);
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
      status: "acted",
      changed: true,
      thread: "t1",
      strip: "thread",
    });
    expect(marks[0]?.hash).not.toBe(first.marks[0]?.hash);
    expect(marks.slice(1).map((m) => m.changed)).toEqual([false, false, false]);
  });
});

describe("the editor's marks and strips (D67)", () => {
  const widgets = (state: EditorState) => {
    const out: number[] = [];
    for (const d of state.facet(EditorView.decorations))
      if (typeof d !== "function") d.between(0, state.doc.length, (from) => void out.push(from));
    return out;
  };
  const make = () => {
    const field = noteCardsField(new SlotStore());
    const state = EditorState.create({
      doc: NOTE,
      extensions: [EditorState.lineSeparator.of("\n"), field],
    });
    return { field, state };
  };

  test("the page's data arrives by effect; the strips follow the text as it changes", () => {
    let { state } = make();
    expect(widgets(state)).toEqual([]);
    state = state.update({ effects: setNoteCards.of(data) }).state;
    const endOf = (n: number) => state.doc.line(n + 1).to;
    expect(widgets(state)).toEqual([endOf(3), endOf(5)]);
    // A line typed above moves them; the text is kept byte for byte.
    state = state.update({ changes: { from: 0, insert: "first\r\n\r\n" } }).state;
    expect(widgets(state)).toEqual([endOf(5), endOf(7)]);
    expect(state.doc.toString()).toBe(`first\r\n\r\n${NOTE}`);
  });

  test("typing in a block with a conversation keeps its strip and key until the rows change", () => {
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
    expect(after).toMatchObject({ key: before?.key, changed: true, strip: "thread" });
    expect(widgets(state)).toHaveLength(2);
    // Typing at the start of a block keeps it too.
    const start = state.doc.line(3).from;
    state = state.update({ changes: { from: start, insert: "  " } }).state;
    expect(state.field(field).marks[0]).toMatchObject({ key: before?.key, changed: true });
    // The reading recorded the new words: its own row, no longer changed, same key.
    const words = state.doc.sliceString(start, state.doc.line(4).to);
    const read = new Map([...data.rows, row(words, { status: "acted", inboxItemId: "t1" })]);
    state = state.update({ effects: setNoteCards.of({ ...data, rows: read }) }).state;
    expect(state.field(field).marks[0]).toMatchObject({ key: before?.key, changed: false });
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

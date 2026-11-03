/**
 * Which block of the note gets which mark (FR-20.7, D67), from the text, the
 * day's block rows matched by hash and the summaries of their threads. Pure:
 * the editor turns it into gutter markers, the hovered block's line classes
 * and the card's anchor.
 *
 * A block is followed through edits by its range in the text (`Carry`, mapped
 * through each change by the editor): a block being edited keeps its key, so
 * its mark and a pinned card stay with it, and keeps the row it had, shown as
 * changed and not read yet, until the reading records its new words.
 */
import { splitBlocks } from "@/services/note/blocks";
import {
  type BlockCard,
  type MarkState,
  markState,
  type ThreadSummary,
} from "@/services/note/cards";

/** What the page knows of the day's blocks. */
export type NoteCardsData = {
  privateHeading: string;
  /** The day's read blocks by hash. */
  rows: ReadonlyMap<string, BlockCard>;
  /** The summaries of their threads, by id. */
  threads: ReadonlyMap<string, ThreadSummary>;
  /** A reading will come for new lines (today, with reading on). */
  reads: boolean;
};

export type BlockMark = {
  /** Stable while the block moves or is edited: the marker's and the card's identity. */
  key: string;
  /** The block's hash now (what Ask sends). */
  hash: string;
  /** 0-based first and last line. */
  line: number;
  toLine: number;
  /** Its row, or the row it had before the words changed. */
  row: BlockCard | null;
  /** Edited since the row was read: changed, not read yet. */
  changed: boolean;
  /** Under the private heading: never sent, so no Ask. */
  private: boolean;
  /** Its conversation, if any. */
  thread: string | null;
  /** What the mark shows and the card holds. */
  state: MarkState;
};

/** A block's range in the text and the row it showed, followed through edits. */
export type Carry = {
  key: string;
  /** The block's words then. */
  hash: string;
  rowHash: string | null;
  from: number;
  to: number;
};

/** A row with a conversation: acted on (or replaced, when the words came back). */
export const threadOf = (row: BlockCard | null | undefined) =>
  row?.inboxItemId && (row.status === "acted" || row.status === "revised") ? row.inboxItemId : null;

export const emptyCards: NoteCardsData = {
  privateHeading: "Private",
  rows: new Map(),
  threads: new Map(),
  reads: false,
};

/** Start offset of each line, lines split on "\n" as the editor does. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return starts;
}

export function blockMarks(
  text: string,
  data: NoteCardsData,
  carries: readonly Carry[] = [],
): { marks: BlockMark[]; carries: Carry[] } {
  const starts = lineStarts(text);
  const lineEnd = (n: number) => (n + 1 < starts.length ? (starts[n + 1] ?? 0) - 1 : text.length);
  const blocks = splitBlocks(text, data.privateHeading).map((b) => ({
    b,
    from: starts[b.fromLine] ?? 0,
    to: lineEnd(b.toLine),
  }));
  // The block each one was before an edit.
  const earlier = matchCarries(blocks, carries);
  const marks: BlockMark[] = [];
  const next: Carry[] = [];
  const copies = new Map<string, number>();
  const keys = new Set<string>();
  for (const [i, { b, from, to }] of blocks.entries()) {
    const copy = copies.get(b.hash) ?? 0;
    copies.set(b.hash, copy + 1);
    const before = earlier.get(i);
    let key = before && !keys.has(before.key) ? before.key : `${b.hash}#${copy}`;
    while (keys.has(key)) key = `${key}'`;
    keys.add(key);
    const own = data.rows.get(b.hash);
    const carried = !own && before?.rowHash ? data.rows.get(before.rowHash) : undefined;
    const row = own ?? carried ?? null;
    next.push({ key, hash: b.hash, rowHash: row?.hash ?? null, from, to });
    const thread = threadOf(row);
    marks.push({
      key,
      hash: b.hash,
      line: b.fromLine,
      toLine: b.toLine,
      row,
      changed: !!carried,
      private: b.private,
      thread,
      state: markState({
        status: row?.status ?? "unread",
        changed: !!carried,
        private: b.private,
        threadId: thread,
        thread: thread ? data.threads.get(thread) : undefined,
        reads: data.reads,
      }),
    });
  }
  return { marks, carries: next };
}

/**
 * Which earlier range each block is: one with the same words (or the words
 * of the row it showed) first, then the largest overlap, each range and each
 * block at most once. A paragraph typed at a block's start overlaps the
 * block's mapped range too, but the block keeps it: its words are the same,
 * or it overlaps more.
 */
function matchCarries(
  blocks: readonly { b: { hash: string }; from: number; to: number }[],
  carries: readonly Carry[],
): Map<number, Carry> {
  const pairs: { i: number; c: Carry; score: number }[] = [];
  for (const [i, { b, from, to }] of blocks.entries())
    for (const c of carries) {
      if (c.from > to || c.to < from) continue;
      const overlap = Math.max(0, Math.min(c.to, to) - Math.max(c.from, from));
      const same = c.hash === b.hash || c.rowHash === b.hash;
      pairs.push({ i, c, score: (same ? 1e9 : 0) + overlap });
    }
  pairs.sort((x, y) => y.score - x.score || x.i - y.i);
  const out = new Map<number, Carry>();
  const taken = new Set<Carry>();
  for (const p of pairs) {
    if (out.has(p.i) || taken.has(p.c)) continue;
    out.set(p.i, p.c);
    taken.add(p.c);
  }
  return out;
}

/** The block whose lines hold this 0-based line: the cursor's (Mod-.) or the pointer's. */
export function blockAtLine(marks: readonly BlockMark[], line: number): BlockMark | null {
  return marks.find((m) => m.line <= line && line <= m.toLine) ?? null;
}

const sameState = (a: MarkState, b: MarkState) =>
  a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * The published mark when nothing the card shows changed (its lines may have
 * moved), so a keystroke elsewhere does not re-render the card.
 */
export function sameMark(before: BlockMark | undefined, now: BlockMark): BlockMark {
  if (!before) return now;
  const same =
    before.hash === now.hash &&
    before.row === now.row &&
    before.changed === now.changed &&
    before.private === now.private &&
    before.thread === now.thread &&
    sameState(before.state, now.state);
  return same ? before : now;
}

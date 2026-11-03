/**
 * Which block of the note gets which mark and strip (FR-20.7, D67), from the
 * text and the day's block rows matched by hash. Pure: the editor turns it
 * into gutter markers and block widgets.
 *
 * A block is followed through edits by its range in the text (`Carry`, mapped
 * through each change by the editor): a block being edited keeps its key, so
 * its mark and strip stay in place, and keeps the row it had, shown as
 * changed and not read yet, until the reading records its new words.
 */
import { splitBlocks } from "@/services/note/blocks";
import type { BlockCard } from "@/services/note/cards";

/** What the page knows of the day's blocks. */
export type NoteCardsData = {
  privateHeading: string;
  /** The day's read blocks by hash. */
  rows: ReadonlyMap<string, BlockCard>;
  /** Threads where a card or a question waits. */
  waiting: ReadonlySet<string>;
};

/** A mark's look: what the reading did, or `unread` (only its menu, for Ask). */
export type MarkStatus = BlockCard["status"] | "unread";

export type BlockMark = {
  /** Stable while the block moves or is edited: the editor's marker and widget identity. */
  key: string;
  /** The block's hash now (what Ask sends). */
  hash: string;
  /** 0-based first and last line. */
  line: number;
  toLine: number;
  /** Its row, or the row it had before the words changed. */
  row: BlockCard | null;
  status: MarkStatus;
  /** Edited since the row was read: changed, not read yet. */
  changed: boolean;
  /** Under the private heading: never sent, so no Ask. */
  private: boolean;
  /** Its conversation, if any. */
  thread: string | null;
  /** A card or a question waits in its thread. */
  waits: boolean;
  /** What goes under it: its conversation, a work item note, or nothing. */
  strip: "thread" | "context" | null;
};

/** A block's range in the text and the row it showed, followed through edits. */
export type Carry = { key: string; rowHash: string | null; from: number; to: number };

/** A row with a conversation: acted on (or replaced, when the words came back). */
export const threadOf = (row: BlockCard | null | undefined) =>
  row?.inboxItemId && (row.status === "acted" || row.status === "revised") ? row.inboxItemId : null;

export const emptyCards: NoteCardsData = {
  privateHeading: "Private",
  rows: new Map(),
  waiting: new Set(),
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
  const marks: BlockMark[] = [];
  const next: Carry[] = [];
  const copies = new Map<string, number>();
  const keys = new Set<string>();
  const taken = new Set<Carry>();
  for (const b of splitBlocks(text, data.privateHeading)) {
    const from = starts[b.fromLine] ?? 0;
    const to = lineEnd(b.toLine);
    const copy = copies.get(b.hash) ?? 0;
    copies.set(b.hash, copy + 1);
    // The block this one was before an edit: the first not yet taken that it overlaps.
    const before = carries.find((c) => !taken.has(c) && c.from <= to && c.to >= from);
    if (before) taken.add(before);
    let key = before && !keys.has(before.key) ? before.key : `${b.hash}#${copy}`;
    while (keys.has(key)) key = `${key}'`;
    keys.add(key);
    const own = data.rows.get(b.hash);
    const carried = !own && before?.rowHash ? data.rows.get(before.rowHash) : undefined;
    const row = own ?? carried ?? null;
    next.push({ key, rowHash: row?.hash ?? null, from, to });
    // A private block the reading has not seen yet: nothing to offer.
    if (!row && b.private) continue;
    const thread = threadOf(row);
    marks.push({
      key,
      hash: b.hash,
      line: b.fromLine,
      toLine: b.toLine,
      row,
      status: row?.status ?? "unread",
      changed: !!carried,
      private: b.private,
      thread,
      waits: !!thread && data.waiting.has(thread),
      strip: thread ? "thread" : row?.status === "context" && row.workItemId ? "context" : null,
    });
  }
  return { marks, carries: next };
}

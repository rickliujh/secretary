/**
 * A turn that has not finished (D68), kept in the thread's `triage` while it
 * runs and after it stopped or failed part way: what a resume reads. A turn
 * that finishes replaces it with its counts, as before.
 */
import { z } from "zod";

/** An item of the turn no card was written for yet. */
export const StoredJobSchema = z.object({
  idx: z.number(),
  /** Its place in the turn, from 0, and how many items the turn has. */
  pos: z.number(),
  count: z.number(),
  quote: z.string(),
  /** Typed instructions it was read with (new input); a revision reads the thread's again. */
  instructions: z.array(z.string()),
  source: z.string().optional(),
  ownInput: z.boolean(),
});
export type StoredJob = z.infer<typeof StoredJobSchema>;

export const RunRecordSchema = z.object({
  /** The turn's id: a resume keeps it, so its unread entry is found again. */
  id: z.string().default(""),
  /** "running" only while the app runs it; one found at start is a stop (`recoverRuns`). */
  state: z.enum(["running", "stopped", "failed"]),
  /** New items to read, or existing items to revise. */
  kind: z.enum(["read", "revise"]),
  /** The user message the turn reads; null for a re-triage. */
  messageId: z.string().nullable(),
  /** The turn's answer, once one item is written. */
  assistantMessageId: z.string().nullable(),
  /** The typed instruction of a revision (for its correction example). */
  instruction: z.string().nullable(),
  /** Where the turn's new input came from. */
  source: z.string(),
  undecided: z.array(StoredJobSchema),
  /** Positions of the items whose calls failed after their retries. */
  failed: z.array(z.number()),
  /** Items decided so far, and the cards they wrote. */
  decided: z.number(),
  cards: z.number(),
  /** The intake items it wrote, and the proposals it replaced: what Edit takes back. */
  itemIds: z.array(z.string()).default([]),
  replaced: z.array(z.string()).default([]),
  at: z.string(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

const TriageWithRun = z.object({ run: RunRecordSchema, error: z.string().optional() }).loose();

const TurnWritten = z.object({
  messageId: z.string().nullable(),
  itemIds: z.array(z.string()),
  replaced: z.array(z.string()),
});
const TriageWithTurn = z.object({ turn: TurnWritten }).loose();

/**
 * What the thread's last turn wrote and replaced, for Edit (D68): from its
 * record while unfinished, from its counts once finished.
 */
export const lastTurnOf = (triage: unknown): z.infer<typeof TurnWritten> | null => {
  const run = runRecordOf(triage);
  if (run) return { messageId: run.messageId, itemIds: run.itemIds, replaced: run.replaced };
  return TriageWithTurn.safeParse(triage).data?.turn ?? null;
};

const TriageWithUnread = z.object({ unread: z.array(RunRecordSchema) }).loose();

/**
 * Turns that stopped or failed with items not read (D68), oldest first. They
 * live in `triage.unread`, which a new turn never overwrites: they stay until a
 * resume reads them or their message is taken back.
 */
export const unreadOf = (triage: unknown): RunRecord[] =>
  TriageWithUnread.safeParse(triage).data?.unread ?? [];

/** The unread list with `record` put in place of its turn's entry (or taken out). */
export const unreadWith = (triage: unknown, id: string, record: RunRecord | null): RunRecord[] => {
  const others = unreadOf(triage).filter((r) => r.id !== id);
  return record?.undecided.length ? [...others, record] : others;
};

/** The unfinished turn a thread's `triage` holds, if any. */
export const runRecordOf = (triage: unknown): RunRecord | null =>
  TriageWithRun.safeParse(triage).data?.run ?? null;

/**
 * The cards a running revision is about to replace (D68): the undecided cards
 * of the items it has not decided yet. They wait for the run.
 */
export function revisedCards(
  triage: unknown,
  items: readonly { id: string; idx: number }[],
  cards: readonly { id: string; intakeItemId: string | null; status: string }[],
): Set<string> {
  const run = runRecordOf(triage);
  if (run?.state !== "running" || run.kind !== "revise") return new Set();
  const idxs = new Set(run.undecided.map((j) => j.idx));
  const itemIds = new Set(items.filter((i) => idxs.has(i.idx)).map((i) => i.id));
  return new Set(
    cards
      .filter((c) => c.status === "pending" && c.intakeItemId && itemIds.has(c.intakeItemId))
      .map((c) => c.id),
  );
}

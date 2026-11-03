/**
 * What the Note page shows on the note's blocks (FR-20.7, D67): the day's
 * block rows (hash, status, thread, work item) and, for the threads among
 * them, a summary for the block's mark and card; the mark's state. Plain
 * queries and logic: no model call, nothing sent anywhere.
 */
import { eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import { dailyNoteBlocks, inboxItems, proposals, workItems } from "@/db/schema";
import { query } from "@/services/db";
import type { BlockStatus } from "./queries";

/** A read block of a day, as the page matches it to the text by hash. */
export type BlockCard = {
  hash: string;
  status: BlockStatus;
  inboxItemId: string | null;
  workItemId: string | null;
  /** The work item a context block was noted on, by name. */
  workItemName: string | null;
};

/** What a block's mark and card say of its thread. */
export type ThreadSummary = {
  id: string;
  status: (typeof inboxItems.$inferSelect)["status"];
  summary: string | null;
  /** The thread's last turn did not go through. */
  error: string | null;
  /** Pending proposals that are not questions; a playbook bundle's steps are one card. */
  waiting: number;
  /** Pending questions. */
  questions: number;
  /** Approved or executed proposals. */
  approved: number;
  /** Proposals whose execution failed. */
  failed: number;
  /** Tickets its executed creates made. */
  created: string[];
};

export const blocksOf = (date: string) =>
  query(
    (d): Promise<BlockCard[]> =>
      d
        .select({
          hash: dailyNoteBlocks.hash,
          status: dailyNoteBlocks.status,
          inboxItemId: dailyNoteBlocks.inboxItemId,
          workItemId: dailyNoteBlocks.workItemId,
          workItemName: workItems.name,
        })
        .from(dailyNoteBlocks)
        .leftJoin(workItems, eq(workItems.id, dailyNoteBlocks.workItemId))
        .where(eq(dailyNoteBlocks.date, date))
        .all(),
  );

export const threadSummaries = (ids: readonly string[]) =>
  Effect.gen(function* () {
    const unique = [...new Set(ids)];
    if (!unique.length) return [] as ThreadSummary[];
    const items = yield* query((d) =>
      d.select().from(inboxItems).where(inArray(inboxItems.id, unique)).all(),
    );
    const rows = yield* query((d) =>
      d
        .select({
          inboxItemId: proposals.inboxItemId,
          kind: proposals.kind,
          status: proposals.status,
          result: proposals.result,
          bundleId: proposals.bundleId,
        })
        .from(proposals)
        .where(inArray(proposals.inboxItemId, unique))
        .orderBy(proposals.seq)
        .all(),
    );
    return items.map((item): ThreadSummary => {
      const own = rows.filter((r) => r.inboxItemId === item.id);
      const pending = own.filter((r) => r.status === "pending");
      const created = own
        .filter((r) => r.kind === "create_issue" && r.status === "executed")
        .map((r) => (r.result as { issueKey?: string } | null)?.issueKey)
        .filter((k): k is string => !!k);
      return {
        id: item.id,
        status: item.status,
        summary: item.summary,
        error: (item.triage as { error?: string } | null)?.error ?? null,
        waiting: cardCount(pending.filter((r) => r.kind !== "needs_clarification")),
        questions: pending.filter((r) => r.kind === "needs_clarification").length,
        approved: own.filter((r) => r.status === "approved" || r.status === "executed").length,
        failed: own.filter((r) => r.status === "failed").length,
        created: [...new Set(created)],
      };
    });
  });

/** Cards as the thread shows them: each bundle once, every other proposal on its own. */
export const cardCount = (rows: readonly { bundleId: string | null }[]) => {
  const bundles = new Set(rows.map((r) => r.bundleId).filter((b): b is string => !!b));
  return bundles.size + rows.filter((r) => !r.bundleId).length;
};

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The mark's state (D67): what the margin shows on a block's first line and
 * what its card holds.
 */
export type MarkState =
  /** Cards wait in its thread (the count); questions may wait too. */
  | { kind: "waiting"; count: number; questions: number }
  /** Only questions wait. */
  | { kind: "question"; count: number }
  /** Everything decided and nothing failed: approved, dismissed, or nothing left. */
  | { kind: "done"; ended: "approved" | "dismissed" | "nothing left" }
  /** Its thread's last turn did not go through (`turn`), or approved cards failed to run. */
  | { kind: "failed"; turn: boolean; count: number }
  /** Noted on a work item. */
  | { kind: "noted" }
  /** Not read yet (new, or changed since it was read), and a reading will come. */
  | { kind: "unread" }
  /** Not read, and no reading will come (an earlier day, reading off): Ask only. */
  | { kind: "not_read" }
  /** Read; the reading left it alone. */
  | { kind: "alone" }
  /** Under the private heading: never sent. */
  | { kind: "private" }
  /** It has a thread whose summary is not loaded yet. */
  | { kind: "loading" };

/**
 * What a thread's summary gives the mark: a last turn that did not go through
 * first (the error stays until a turn succeeds), then what waits, else how it
 * ended.
 */
export function threadMark(t: ThreadSummary): MarkState {
  if (t.status === "dismissed") return { kind: "done", ended: "dismissed" };
  if (t.error) return { kind: "failed", turn: true, count: t.failed };
  if (t.waiting) return { kind: "waiting", count: t.waiting, questions: t.questions };
  if (t.questions) return { kind: "question", count: t.questions };
  if (t.failed) return { kind: "failed", turn: false, count: t.failed };
  if (t.approved) return { kind: "done", ended: "approved" };
  return { kind: "done", ended: "nothing left" };
}

/** A block's mark state, from its row (or none), its words and its thread. */
export function markState(b: {
  /** Its row's status, or "unread" without one. */
  status: BlockStatus | "unread";
  /** Its words changed since its row was read. */
  changed: boolean;
  /** Under the private heading now. */
  private: boolean;
  /** Its conversation, if any. */
  threadId: string | null;
  /** That conversation's summary; undefined while it loads. */
  thread: ThreadSummary | undefined;
  /** A reading will come (today, with reading on). */
  reads: boolean;
}): MarkState {
  if (b.private || b.status === "private") return { kind: "private" };
  if (b.status === "unread" || b.changed) return { kind: b.reads ? "unread" : "not_read" };
  if (b.threadId) return b.thread ? threadMark(b.thread) : { kind: "loading" };
  if (b.status === "context") return { kind: "noted" };
  return { kind: "alone" };
}

/** The mark's words, for its label: "2 cards waiting", "1 question", "approved"... */
export function markLabel(m: MarkState): string {
  switch (m.kind) {
    case "waiting":
      return `${count(m.count, "card")} waiting${m.questions ? `, ${count(m.questions, "question")}` : ""}`;
    case "question":
      return count(m.count, "question");
    case "done":
      return m.ended;
    case "failed":
      return m.turn ? "did not go through" : `${m.count} failed`;
    case "noted":
      return "noted on a work item";
    case "unread":
      return "not read yet";
    case "not_read":
      return "not read";
    case "alone":
      return "nothing to do";
    case "private":
      return "private, never sent";
    case "loading":
      return "reading...";
  }
}

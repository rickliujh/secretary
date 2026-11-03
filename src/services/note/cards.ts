/**
 * What the Note page shows on the note's blocks (FR-20.7, D67): the day's
 * block rows (hash, status, thread, work item) and, for the threads among
 * them, a summary for the strip under the block. Plain queries: no model
 * call, nothing sent anywhere.
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

/** What the strip under a block says of its thread. */
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
 * The strip's badge (D67): what waits in the thread, else how it ended:
 * "2 cards waiting", "1 question", "approved", "dismissed" or "nothing left";
 * a turn that did not go through and a failed execution say so.
 */
export function stripBadge(t: ThreadSummary): string {
  if (t.status === "dismissed") return "dismissed";
  const waits: string[] = [];
  if (t.waiting) waits.push(`${count(t.waiting, "card")} waiting`);
  if (t.questions) waits.push(count(t.questions, "question"));
  if (waits.length) return waits.join(", ");
  if (t.error && !t.approved && !t.failed) return "did not go through";
  if (t.failed) return `${t.failed} failed`;
  if (t.approved) return "approved";
  return "nothing left";
}

/** Whether a card or a question waits for the user. */
export const stripWaits = (t: ThreadSummary) =>
  t.status !== "dismissed" && t.waiting + t.questions > 0;

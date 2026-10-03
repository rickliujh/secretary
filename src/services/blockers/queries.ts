/**
 * Reads for woken tickets (D45): Today (Phase 16) lists them first, and the
 * reminder loop sends one notification for each.
 */
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { Effect } from "effect";
import { issueMeta, jiraIssues } from "@/db/schema";
import { query } from "@/services/db";
import { getState, SYNC_KEYS } from "@/services/sync/state";
import { parseBlockers, type WokenTicket, wokenTickets } from "./logic";

/**
 * Tickets whose last open blocker closed in the last seven days and that are
 * still open, not viewed since and not snoozed, newest first, with the reason
 * ("PLAT-812 moved to Done on 2 Oct").
 */
export const loadWokenTickets = (now = new Date()) =>
  Effect.gen(function* () {
    const rows = yield* query((d) =>
      d
        .select({
          key: issueMeta.issueKey,
          summary: jiraIssues.summary,
          statusCategory: jiraIssues.statusCategory,
          unblockedAt: issueMeta.unblockedAt,
          unblockedBy: issueMeta.unblockedBy,
          unblockNotifiedAt: issueMeta.unblockNotifiedAt,
          lastViewedAt: issueMeta.lastViewedAt,
          snoozedUntil: issueMeta.snoozedUntil,
        })
        .from(issueMeta)
        .innerJoin(jiraIssues, eq(jiraIssues.key, issueMeta.issueKey))
        .where(and(isNotNull(issueMeta.unblockedAt), eq(jiraIssues.stale, false)))
        .all(),
    );
    const blockers = parseBlockers(yield* getState(SYNC_KEYS.blockers));
    return wokenTickets(rows, blockers, now);
  });

/** Woken tickets whose one notification has not been sent yet. */
export const dueUnblockNotifications = (now = new Date()) =>
  Effect.map(loadWokenTickets(now), (list): WokenTicket[] => list.filter((t) => !t.notified));

/** Records that the wake-up notification for these tickets was sent. */
export const markUnblockNotified = (keys: readonly string[], at: string) =>
  Effect.asVoid(
    query((d) =>
      d
        .update(issueMeta)
        .set({ unblockNotifiedAt: at })
        .where(inArray(issueMeta.issueKey, keys.length ? [...keys] : [""])),
    ),
  );

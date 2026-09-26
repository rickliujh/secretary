/**
 * Cleanup that keeps the database from growing without limit (design.md D34).
 * Only caches and derived data go; the user's own records stay.
 */
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { Effect } from "effect";
import { intakeItems, jiraComments, jiraIssues, llmCalls } from "@/db/schema";
import { query } from "@/services/db";
import { getState, SYNC_KEYS, setState } from "@/services/sync/state";

const DAY = 86_400_000;
export const RETENTION = {
  llmCallsDays: 90,
  staleIssueDays: 30,
  snapshotDays: 180,
  /** Vacuum when at least this much of the file is free pages. */
  vacuumFreeBytes: 20 * 1024 * 1024,
  /** A cleanup this recent is not repeated by the daily schedule. */
  minHoursBetween: 20,
} as const;

/** What stands in for a snapshot once it has been emptied; replay skips these. */
export const PRUNED_SNAPSHOT = { pruned: true } as const;

export type CleanupResult = {
  at: string;
  llmCalls: number;
  staleIssues: number;
  snapshots: number;
  vacuumed: boolean;
  /** Database size in bytes after the cleanup. */
  bytes: number;
};

const ago = (now: Date, days: number) => new Date(now.getTime() - days * DAY).toISOString();

/** Database size and free space, in bytes. */
export const databaseSize = Effect.gen(function* () {
  const [row] = yield* query((d) =>
    d.all<[number, number, number]>(
      sql`SELECT p.page_count, f.freelist_count, s.page_size
          FROM pragma_page_count() p, pragma_freelist_count() f, pragma_page_size() s`,
    ),
  );
  const [pages = 0, free = 0, page = 4096] = (row ?? []).map(Number);
  return { bytes: pages * page, freeBytes: free * page };
});

export const lastCleanup = Effect.map(getState(SYNC_KEYS.lastCleanup), (v) => {
  try {
    return v ? (JSON.parse(v) as CleanupResult) : null;
  } catch {
    return null;
  }
});

/** Runs the cleanup now. */
export const cleanup = (now = new Date()) =>
  Effect.gen(function* () {
    const calls = yield* query((d) =>
      d
        .delete(llmCalls)
        .where(lt(llmCalls.at, ago(now, RETENTION.llmCallsDays)))
        .returning({ id: llmCalls.id }),
    );
    // Stale issues: Jira stopped returning them (full sync) a while ago.
    const gone = yield* query((d) =>
      d
        .select({ key: jiraIssues.key })
        .from(jiraIssues)
        .where(
          and(
            eq(jiraIssues.stale, true),
            lt(jiraIssues.syncedAt, ago(now, RETENTION.staleIssueDays)),
          ),
        )
        .all(),
    );
    const keys = gone.map((g) => g.key);
    for (let i = 0; i < keys.length; i += 200) {
      const chunk = keys.slice(i, i + 200);
      yield* query((d) => d.delete(jiraComments).where(inArray(jiraComments.issueKey, chunk)));
      yield* query((d) => d.delete(jiraIssues).where(inArray(jiraIssues.key, chunk)));
    }
    // Intake ids are ULIDs, so their text order is creation order.
    const cutoffId = ulidAt(new Date(now.getTime() - RETENTION.snapshotDays * DAY));
    const pruned = yield* query((d) =>
      d
        .update(intakeItems)
        .set({ snapshot: PRUNED_SNAPSHOT })
        .where(
          and(
            lt(intakeItems.id, cutoffId),
            sql`json_extract(${intakeItems.snapshot}, '$.pruned') IS NULL`,
          ),
        )
        .returning({ id: intakeItems.id }),
    );
    let size = yield* databaseSize;
    const vacuumed = size.freeBytes >= RETENTION.vacuumFreeBytes;
    if (vacuumed) {
      yield* query((d) => d.run(sql`VACUUM`));
      size = yield* databaseSize;
    }
    const result: CleanupResult = {
      at: now.toISOString(),
      llmCalls: calls.length,
      staleIssues: keys.length,
      snapshots: pruned.length,
      vacuumed,
      bytes: size.bytes,
    };
    yield* setState(SYNC_KEYS.lastCleanup, JSON.stringify(result));
    return result;
  });

/** Runs the cleanup unless one ran recently (the daily schedule). */
export const cleanupIfDue = (now = new Date()) =>
  Effect.gen(function* () {
    const last = yield* lastCleanup;
    if (last && now.getTime() - Date.parse(last.at) < RETENTION.minHoursBetween * 3_600_000)
      return null;
    return yield* cleanup(now);
  });

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** The smallest ULID for a moment: its 10-character time prefix, then zeros. */
export function ulidAt(date: Date): string {
  let t = date.getTime();
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return `${out}${"0".repeat(16)}`;
}

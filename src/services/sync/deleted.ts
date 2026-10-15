/**
 * What a revoke left of a ticket, kept on the ticket so every thread sees it
 * (FR-14.6, D54). A deleted ticket's tombstone outlives the cached issue: sync
 * never stores it again (a search on Jira Cloud is eventually consistent and may
 * still return a deleted issue, and a sync running beside the revoke may write it
 * back), retrieval never offers it and validation rejects a proposal that
 * targets it, in every thread. A closed ticket keeps `issue_meta.revoked_at`
 * until it is seen reopened.
 */
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import { Effect } from "effect";
import { deletedIssues, issueMeta, jiraComments, jiraIssues } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { query } from "@/services/db";
import { isRevokeStatus } from "@/services/jira/cancel";

/** Keys of every ticket a revoke deleted. */
export const deletedKeys = query((d) =>
  d.select({ key: deletedIssues.issueKey }).from(deletedIssues).all(),
).pipe(Effect.map((rows) => new Set(rows.map((r) => r.key))));

/**
 * The cached keys of the ticket `key` names: the key itself, and every key the
 * cache holds under the same Jira id (a ticket moved to another project keeps
 * its id under a new key).
 */
const sameTicket = (key: string) =>
  Effect.gen(function* () {
    const ids = (yield* query((d) =>
      d.select({ id: jiraIssues.id }).from(jiraIssues).where(eq(jiraIssues.key, key)).all(),
    )).map((r) => r.id);
    const rows = yield* query((d) =>
      d
        .select({ key: jiraIssues.key, id: jiraIssues.id })
        .from(jiraIssues)
        .where(
          ids.length
            ? or(eq(jiraIssues.key, key), inArray(jiraIssues.id, ids))
            : eq(jiraIssues.key, key),
        )
        .all(),
    );
    const byKey = new Map<string, string | null>(rows.map((r) => [r.key, r.id]));
    if (!byKey.has(key)) byKey.set(key, null);
    return byKey;
  });

/**
 * Records that a revoke deleted `key` (with the id the cache held, and the other
 * keys the cache holds that id under), before the cached rows go, so a sync that
 * reads the tombstone after this point drops them. Returns the keys recorded.
 */
export const recordDeleted = (key: string, proposalId: string | null) =>
  Effect.gen(function* () {
    const keys = yield* sameTicket(key);
    const deletedAt = nowIso();
    yield* query((d) =>
      d
        .insert(deletedIssues)
        .values(
          [...keys].map(([issueKey, issueId]) => ({ issueKey, issueId, deletedAt, proposalId })),
        )
        .onConflictDoNothing(),
    );
    return [...keys.keys()];
  });

/** Removes cached tickets with their comments and Secretary's notes on them. */
const forgetKeys = (keys: readonly string[]) =>
  Effect.gen(function* () {
    if (keys.length === 0) return;
    yield* query((d) => d.delete(jiraComments).where(inArray(jiraComments.issueKey, [...keys])));
    yield* query((d) => d.delete(issueMeta).where(inArray(issueMeta.issueKey, [...keys])));
    yield* query((d) => d.delete(jiraIssues).where(inArray(jiraIssues.key, [...keys])));
  });

/**
 * A ticket a revoke deleted (or found gone) leaves the cache, by its key and by
 * its Jira id, and keeps its tombstone.
 */
export const forgetDeleted = (key: string, proposalId: string | null) =>
  Effect.flatMap(recordDeleted(key, proposalId), forgetKeys);

/** Whether a revoked ticket in this status still counts as closed by the revoke. */
export const stillRevoked = (issue: { status: string; statusCategory: string }) =>
  issue.statusCategory === "done" || isRevokeStatus(issue.status);

/**
 * A ticket a revoke closed that is seen reopened (outside the done category and
 * the revoke statuses) is no longer marked revoked.
 */
export const clearReopened = (
  issues: readonly { key: string; status: string; statusCategory: string }[],
) =>
  Effect.gen(function* () {
    const open = issues.filter((i) => !stillRevoked(i)).map((i) => i.key);
    if (open.length === 0) return;
    yield* query((d) =>
      d
        .update(issueMeta)
        .set({ revokedAt: null })
        .where(and(inArray(issueMeta.issueKey, open), isNotNull(issueMeta.revokedAt))),
    );
  });

/**
 * The issues of a sync page minus those a revoke deleted. Jira never gives a key
 * to another issue, but should one come back under the key with another id, it
 * is a different issue: its tombstone is lifted and it is stored.
 */
export const withoutDeleted = <T extends { key: string; id: string }>(rows: readonly T[]) =>
  Effect.gen(function* () {
    if (rows.length === 0) return [...rows];
    const tombs = yield* query((d) =>
      d
        .select({ key: deletedIssues.issueKey, id: deletedIssues.issueId })
        .from(deletedIssues)
        .where(
          inArray(
            deletedIssues.issueKey,
            rows.map((r) => r.key),
          ),
        )
        .all(),
    );
    if (tombs.length === 0) return [...rows];
    const byKey = new Map(tombs.map((t) => [t.key, t.id]));
    const reused = rows.filter((r) => {
      const id = byKey.get(r.key);
      return id !== undefined && id !== null && id !== r.id;
    });
    if (reused.length)
      yield* query((d) =>
        d.delete(deletedIssues).where(
          inArray(
            deletedIssues.issueKey,
            reused.map((r) => r.key),
          ),
        ),
      );
    const lifted = new Set(reused.map((r) => r.key));
    return rows.filter((r) => !byKey.has(r.key) || lifted.has(r.key));
  });

/**
 * Removes from the cache any ticket a revoke deleted that got there anyway (a
 * sync page read before the revoke and written after it), with its comments and
 * Secretary's notes on it. Returns the keys removed.
 */
export const sweepDeleted = Effect.gen(function* () {
  const tombs = yield* query((d) =>
    d
      .select({ key: jiraIssues.key })
      .from(jiraIssues)
      .innerJoin(deletedIssues, eq(deletedIssues.issueKey, jiraIssues.key))
      .all(),
  );
  const keys = tombs.map((t) => t.key);
  yield* forgetKeys(keys);
  return keys;
});

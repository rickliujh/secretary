/**
 * Bulk writes for sync: one statement per page keeps IPC round trips low.
 *
 * Before writing, each page is diffed against the cached rows (D61): a field
 * that changed on a ticket the cache held, and a comment it did not hold, is a
 * work event. Who the event is by depends on why the issue was read (`origin`).
 */
import { getTableColumns, inArray, sql } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { Effect } from "effect";
import { jiraComments, jiraIssues } from "@/db/schema";
import { query } from "@/services/db";
import type { CommentRow, IssueRow } from "@/services/jira/mapping";
import {
  type DiffRow,
  type FieldChange,
  issueChangeEvents,
  newCommentEvents,
} from "@/services/work/diff";
import { contactsByJiraId, jiraActor, recordEvents } from "@/services/work/events";
import { chunk } from "./jql";
import { getState, SYNC_KEYS } from "./state";

/**
 * Why issues are written, for the events their changes become (D61): `sync`, a
 * change seen in Jira (by the comment's author, else the sync); `none`, a read
 * that records nothing (a candidate read). After the app's own write the
 * re-read says what that write did (`own`): those changes are the user's
 * `ticket_edited` (`by: "user"`) or dropped, since the approved proposal is the
 * event (`by: "proposal"`); every other change is recorded as at sync, by its
 * real author.
 */
export type WriteOrigin =
  | "sync"
  | "none"
  | {
      by: "user" | "proposal";
      fields: readonly FieldChange["field"][];
      commentIds: readonly string[];
    };

const ownOf = (origin: WriteOrigin) => (typeof origin === "object" ? origin : null);

/** `SET col = excluded.col` for every column except the conflict target. */
function excludedSet(table: SQLiteTable, skip: readonly string[]) {
  const set: Record<string, ReturnType<typeof sql>> = {};
  for (const [prop, column] of Object.entries(getTableColumns(table)) as [string, SQLiteColumn][]) {
    if (skip.includes(column.name)) continue;
    set[prop] = sql.raw(`excluded."${column.name}"`);
  }
  return set;
}

const ISSUE_SET = excludedSet(jiraIssues, ["key"]);

// ~30 columns per issue; SQLite allows 32766 bound parameters per statement.
const ISSUES_PER_STATEMENT = 200;
const COMMENTS_PER_STATEMENT = 400;

const cachedRows = (keys: readonly string[]) =>
  Effect.gen(function* () {
    const out = new Map<string, DiffRow>();
    for (const part of chunk(keys, 500)) {
      const rows = yield* query((db) =>
        db
          .select({
            key: jiraIssues.key,
            summary: jiraIssues.summary,
            status: jiraIssues.status,
            assignee: jiraIssues.assignee,
            assigneeDisplay: jiraIssues.assigneeDisplay,
            dueDate: jiraIssues.dueDate,
            sprint: jiraIssues.sprint,
            storyPoints: jiraIssues.storyPoints,
            resolved: jiraIssues.resolved,
            links: sql<string | null>`json_extract(${jiraIssues.raw}, '$.issuelinks')`,
            updated: jiraIssues.updated,
          })
          .from(jiraIssues)
          .where(inArray(jiraIssues.key, part))
          .all(),
      );
      for (const r of rows) out.set(r.key, r);
    }
    return out;
  });

const diffRowOf = (r: IssueRow): DiffRow => ({
  key: r.key,
  summary: r.summary,
  status: r.status,
  assignee: r.assignee ?? null,
  assigneeDisplay: r.assigneeDisplay ?? null,
  dueDate: r.dueDate ?? null,
  sprint: r.sprint ?? null,
  storyPoints: r.storyPoints ?? null,
  resolved: r.resolved ?? null,
  links: (r.raw as { issuelinks?: unknown } | null)?.issuelinks ?? null,
  updated: r.updated,
});

/** The events of a page's changes, with the app's own write taken out or made the user's. */
const changeEvents = (
  before: ReadonlyMap<string, DiffRow>,
  rows: readonly IssueRow[],
  origin: WriteOrigin,
) => {
  const own = ownOf(origin);
  return issueChangeEvents(before, rows.map(diffRowOf), {
    kind: "jira_change",
    actor: "sync",
  }).flatMap((e) => {
    const field = (e.data as { field?: FieldChange["field"] } | undefined)?.field;
    if (!own || !field || !own.fields.includes(field)) return [e];
    return own.by === "user"
      ? [{ ...e, kind: "ticket_edited" as const, actor: "me" as const, at: undefined }]
      : [];
  });
};

/**
 * Writes issues and records their changes as events. Returns the keys the
 * cache held before, for `replaceComments`.
 */
export const upsertIssues = (rows: readonly IssueRow[], origin: WriteOrigin = "sync") =>
  Effect.gen(function* () {
    const before: ReadonlyMap<string, DiffRow> =
      origin === "none" ? new Map() : yield* cachedRows(rows.map((r) => r.key));
    for (const part of chunk(rows, ISSUES_PER_STATEMENT))
      yield* query((db) =>
        db
          .insert(jiraIssues)
          .values(part)
          .onConflictDoUpdate({ target: jiraIssues.key, set: ISSUE_SET }),
      );
    if (origin !== "none" && before.size > 0)
      yield* recordEvents(changeEvents(before, rows, origin));
    return new Set(before.keys()) as ReadonlySet<string>;
  });

/**
 * Replaces all cached comments of the given issues. A comment the cache did not
 * hold, on an issue it held before this write (`cachedBefore`), is an event by
 * its author (D61).
 */
export const replaceComments = (
  issueKeys: readonly string[],
  rows: readonly CommentRow[],
  opts: { origin?: WriteOrigin; cachedBefore?: ReadonlySet<string> } = {},
) =>
  Effect.gen(function* () {
    const origin = opts.origin ?? "sync";
    const cachedIssues = opts.cachedBefore ?? new Set<string>();
    const known = new Set<string>();
    if (origin !== "none" && cachedIssues.size > 0)
      for (const keys of chunk(
        issueKeys.filter((k) => cachedIssues.has(k)),
        500,
      )) {
        const old = yield* query((db) =>
          db
            .select({ id: jiraComments.id })
            .from(jiraComments)
            .where(inArray(jiraComments.issueKey, keys))
            .all(),
        );
        for (const c of old) known.add(c.id);
      }
    for (const keys of chunk(issueKeys, 500)) {
      yield* query((db) => db.delete(jiraComments).where(inArray(jiraComments.issueKey, keys)));
    }
    for (const part of chunk(rows, COMMENTS_PER_STATEMENT)) {
      yield* query((db) => db.insert(jiraComments).values(part).onConflictDoNothing());
    }
    if (origin === "none" || cachedIssues.size === 0) return;
    const me = (yield* getState(SYNC_KEYS.username)) ?? null;
    const contacts = yield* contactsByJiraId;
    const events = newCommentEvents(
      known,
      cachedIssues,
      rows.map((r) => ({
        id: r.id,
        issueKey: r.issueKey,
        author: r.author ?? null,
        authorDisplay: r.authorDisplay ?? null,
        body: r.body,
        created: r.created,
      })),
      (author) => jiraActor(author, me, contacts),
    );
    // The comment the app's own write posted is the user's edit, or the approved
    // proposal's (no second event); everyone else's comments are theirs.
    const own = ownOf(origin);
    yield* recordEvents(
      events.flatMap((e) => {
        if (!own || !e.ref || !own.commentIds.includes(e.ref)) return [e];
        return own.by === "user"
          ? [{ ...e, kind: "ticket_edited" as const, actor: "me" as const }]
          : [];
      }),
    );
  });

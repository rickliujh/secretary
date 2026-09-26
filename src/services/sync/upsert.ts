/** Bulk writes for sync: one statement per page keeps IPC round trips low. */
import { getTableColumns, inArray, sql } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { Effect } from "effect";
import { jiraComments, jiraIssues } from "@/db/schema";
import { query } from "@/services/db";
import type { CommentRow, IssueRow } from "@/services/jira/mapping";
import { chunk } from "./jql";

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

export const upsertIssues = (rows: readonly IssueRow[]) =>
  Effect.forEach(
    chunk(rows, ISSUES_PER_STATEMENT),
    (part) =>
      query((db) =>
        db
          .insert(jiraIssues)
          .values(part)
          .onConflictDoUpdate({ target: jiraIssues.key, set: ISSUE_SET }),
      ),
    { discard: true },
  );

/** Replaces all cached comments of the given issues. */
export const replaceComments = (issueKeys: readonly string[], rows: readonly CommentRow[]) =>
  Effect.gen(function* () {
    for (const keys of chunk(issueKeys, 500)) {
      yield* query((db) => db.delete(jiraComments).where(inArray(jiraComments.issueKey, keys)));
    }
    for (const part of chunk(rows, COMMENTS_PER_STATEMENT)) {
      yield* query((db) => db.insert(jiraComments).values(part).onConflictDoNothing());
    }
  });

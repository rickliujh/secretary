/** Read queries for the ticket browser. Local writes here touch only secretary data. */
import { asc, eq, getTableColumns, sql } from "drizzle-orm";
import { Effect } from "effect";
import { issueMeta, jiraComments, jiraIssues } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { query } from "@/services/db";
import { getState, SYNC_KEYS } from "@/services/sync/state";
import { ftsQuery, type TicketRow } from "./tree";

const listColumns = {
  key: jiraIssues.key,
  projectKey: jiraIssues.projectKey,
  issueType: jiraIssues.issueType,
  isSubtask: jiraIssues.isSubtask,
  summary: jiraIssues.summary,
  status: jiraIssues.status,
  statusCategory: jiraIssues.statusCategory,
  priority: jiraIssues.priority,
  assignee: jiraIssues.assignee,
  assigneeDisplay: jiraIssues.assigneeDisplay,
  parentKey: jiraIssues.parentKey,
  epicKey: jiraIssues.epicKey,
  epicName: jiraIssues.epicName,
  dueDate: jiraIssues.dueDate,
  updated: jiraIssues.updated,
  isTrackedEpic: jiraIssues.isTrackedEpic,
  stale: jiraIssues.stale,
};

/** Every cached issue without the heavy columns (raw, description). */
export const listTicketRows = query(
  (db): Promise<TicketRow[]> => db.select(listColumns).from(jiraIssues).all(),
);

export const SEARCH_LIMIT = 500;

/** Keys matching free text, best first. Exact issue keys always match. */
export const searchTicketKeys = (text: string) =>
  Effect.gen(function* () {
    const keys = new Set<string>();
    const upper = text.trim().toUpperCase();
    if (/^[A-Z][A-Z0-9_]+-\d+$/.test(upper)) keys.add(upper);
    const match = ftsQuery(text);
    if (!match) return keys;
    const rows = yield* query((db) =>
      db
        .select({ key: jiraIssues.key })
        .from(jiraIssues)
        .where(
          sql`${jiraIssues}.rowid IN (SELECT rowid FROM jira_issues_fts WHERE jira_issues_fts MATCH ${match})`,
        )
        .limit(SEARCH_LIMIT)
        .all(),
    );
    for (const r of rows) keys.add(r.key);
    return keys;
  });

export const ticketDetail = (key: string) =>
  Effect.gen(function* () {
    const issue = yield* query((db) =>
      db.select(getTableColumns(jiraIssues)).from(jiraIssues).where(eq(jiraIssues.key, key)).get(),
    );
    if (!issue) return null;
    const comments = yield* query((db) =>
      db
        .select()
        .from(jiraComments)
        .where(eq(jiraComments.issueKey, key))
        .orderBy(asc(jiraComments.created))
        .all(),
    );
    const meta = yield* query((db) =>
      db.select().from(issueMeta).where(eq(issueMeta.issueKey, key)).get(),
    );
    return { issue, comments, meta: meta ?? null };
  });

export type TicketDetail = NonNullable<Effect.Effect.Success<ReturnType<typeof ticketDetail>>>;

export const markViewed = (key: string) =>
  query((db) =>
    db
      .insert(issueMeta)
      .values({ issueKey: key, lastViewedAt: nowIso() })
      .onConflictDoUpdate({ target: issueMeta.issueKey, set: { lastViewedAt: nowIso() } }),
  );

export const epicsInProject = (projectKey: string) =>
  query((db) =>
    db
      .select({ key: jiraIssues.key, summary: jiraIssues.summary, epicName: jiraIssues.epicName })
      .from(jiraIssues)
      .where(
        sql`${jiraIssues.projectKey} = ${projectKey} AND ${jiraIssues.issueType} = 'Epic' AND ${jiraIssues.stale} = 0`,
      )
      .orderBy(asc(jiraIssues.key))
      .all(),
  );

/** Jira username of the signed-in user, recorded by sync; null before the first sync. */
export const currentJiraUsername = Effect.map(getState(SYNC_KEYS.username), (v) => v ?? null);

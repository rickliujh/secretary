/** Loads one snapshot of the cache for the dashboard (FR-5). */
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { Effect } from "effect";
import { issueMeta, jiraComments, jiraIssues } from "@/db/schema";
import { query } from "@/services/db";
import { listDependencies } from "@/services/dependencies/queries";
import { Settings, settingsOrDefault } from "@/services/settings";
import { getState, SYNC_KEYS } from "@/services/sync/state";
import type { DashboardInputs, DashIssue, IssueLink } from "./sections";

const COMMENT_WINDOW_DAYS = 14;

const parseLinks = (value: unknown): IssueLink[] => {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as IssueLink[]) : [];
  } catch {
    return [];
  }
};

export const loadDashboardInputs = (now = new Date()) =>
  Effect.gen(function* () {
    const settings = yield* settingsOrDefault(yield* Settings);
    const me = (yield* getState(SYNC_KEYS.username)) ?? null;
    const rows = yield* query((d) =>
      d
        .select({
          key: jiraIssues.key,
          issueType: jiraIssues.issueType,
          isSubtask: jiraIssues.isSubtask,
          summary: jiraIssues.summary,
          status: jiraIssues.status,
          statusCategory: jiraIssues.statusCategory,
          priority: jiraIssues.priority,
          assignee: jiraIssues.assignee,
          assigneeDisplay: jiraIssues.assigneeDisplay,
          epicKey: jiraIssues.epicKey,
          dueDate: jiraIssues.dueDate,
          updated: jiraIssues.updated,
          links: sql<string | null>`json_extract(${jiraIssues.raw}, '$.issuelinks')`,
          pinned: issueMeta.pinned,
          snoozedUntil: issueMeta.snoozedUntil,
          priorityOverride: issueMeta.priorityOverride,
          lastViewedAt: issueMeta.lastViewedAt,
        })
        .from(jiraIssues)
        .leftJoin(issueMeta, eq(issueMeta.issueKey, jiraIssues.key))
        .where(eq(jiraIssues.stale, false))
        .all(),
    );
    const issues: DashIssue[] = rows.map((r) => ({
      ...r,
      links: parseLinks(r.links),
      pinned: !!r.pinned,
      snoozedUntil: r.snoozedUntil ?? null,
      priorityOverride: r.priorityOverride ?? null,
      lastViewedAt: r.lastViewedAt ?? null,
    }));

    const since = new Date(now.getTime() - COMMENT_WINDOW_DAYS * 86_400_000).toISOString();
    // Wiki mentions: `[~username]` on Data Center, `[~accountid:ID]` on Cloud.
    const mentions = me ? [`[~${me}]`, `[~accountid:${me}]`] : [];
    const comments = yield* query((d) =>
      d
        .select({
          issueKey: jiraComments.issueKey,
          author: jiraComments.author,
          authorDisplay: jiraComments.authorDisplay,
          created: jiraComments.created,
          mentionsMe: mentions.length
            ? sql<number>`(instr(lower(${jiraComments.body}), lower(${mentions[0]})) > 0 OR instr(lower(${jiraComments.body}), lower(${mentions[1]})) > 0)`
            : sql<number>`0`,
        })
        .from(jiraComments)
        .where(and(gte(jiraComments.created, since)))
        .orderBy(desc(jiraComments.created))
        .all(),
    );

    const deps = yield* listDependencies();
    return {
      me,
      trackedEpics: settings.jira.trackedEpics,
      issues,
      dependencies: deps.map((x) => ({
        id: x.id,
        issueKey: x.issueKey,
        label: x.label,
        externalRef: x.externalRef,
        status: x.status,
        expectedAt: x.expectedAt,
        nextFollowupAt: x.nextFollowupAt,
        ownerName: x.owner.name,
      })),
      comments: comments.map((c) => ({ ...c, mentionsMe: !!Number(c.mentionsMe) })),
    } satisfies DashboardInputs;
  });

// ---------------------------------------------------------------------------
// Local, secretary-only ticket state (FR-5.3): never written to Jira.
// ---------------------------------------------------------------------------

const upsertMeta = (issueKey: string, set: Partial<typeof issueMeta.$inferInsert>) =>
  query((d) =>
    d
      .insert(issueMeta)
      .values({ issueKey, ...set })
      .onConflictDoUpdate({ target: issueMeta.issueKey, set }),
  );

export const setPinned = (issueKey: string, pinned: boolean) => upsertMeta(issueKey, { pinned });

/** Hides an issue from Top focus until `until` (ISO timestamp); null wakes it. */
export const snooze = (issueKey: string, until: string | null) =>
  upsertMeta(issueKey, { snoozedUntil: until });

/** Local adjustment added to the ranking score; null clears it. */
export const setOverride = (issueKey: string, points: number | null) =>
  upsertMeta(issueKey, { priorityOverride: points });

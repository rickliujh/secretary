/** Loads one snapshot of the cache for Today (FR-12) and the views built on its ranking. */
import { and, asc, desc, eq, gte, ne, sql } from "drizzle-orm";
import { Effect } from "effect";
import { inboxItems, issueMeta, jiraComments, jiraIssues, people, proposals } from "@/db/schema";
import { localDate } from "@/lib/dates";
import { parseBlockers } from "@/services/blockers/logic";
import { loadWokenTickets } from "@/services/blockers/queries";
import { query } from "@/services/db";
import { listDependencies } from "@/services/dependencies/queries";
import { parseIssueLinks } from "@/services/jira/schemas";
import { Settings, settingsOrDefault } from "@/services/settings";
import { getState, parseSprintState, SYNC_KEYS } from "@/services/sync/state";
import { pendingOutcomes } from "@/services/work/outcomes";
import { workByIssue } from "@/services/work/queries";
import { buildEpicHealth, type DashboardInputs, type DashIssue } from "./sections";
import { buildToday, groupThreads, type TodayInputs } from "./today";

const COMMENT_WINDOW_DAYS = 14;

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
          sprint: jiraIssues.sprint,
          dueDate: jiraIssues.dueDate,
          created: jiraIssues.created,
          updated: jiraIssues.updated,
          labels: jiraIssues.labels,
          links: sql<string | null>`json_extract(${jiraIssues.raw}, '$.issuelinks')`,
          pinned: issueMeta.pinned,
          snoozedUntil: issueMeta.snoozedUntil,
          priorityOverride: issueMeta.priorityOverride,
          lastViewedAt: issueMeta.lastViewedAt,
          requesterId: issueMeta.requesterPersonId,
          requesterName: people.displayName,
        })
        .from(jiraIssues)
        .leftJoin(issueMeta, eq(issueMeta.issueKey, jiraIssues.key))
        .leftJoin(people, eq(people.id, issueMeta.requesterPersonId))
        .where(eq(jiraIssues.stale, false))
        .all(),
    );
    const issues: DashIssue[] = rows.map(({ requesterId, requesterName, ...r }) => ({
      ...r,
      labels: r.labels ?? [],
      links: parseIssueLinks(r.links),
      pinned: !!r.pinned,
      snoozedUntil: r.snoozedUntil ?? null,
      priorityOverride: r.priorityOverride ?? null,
      lastViewedAt: r.lastViewedAt ?? null,
      requester: requesterId && requesterName ? { id: requesterId, name: requesterName } : null,
    }));

    const since = new Date(now.getTime() - COMMENT_WINDOW_DAYS * 86_400_000).toISOString();
    // Wiki mentions: `[~username]` on Data Center, `[~accountid:ID]` on Cloud.
    const mentions = me ? [`[~${me}]`, `[~accountid:${me}]`] : [];
    const comments = yield* query((d) =>
      d
        .select({
          id: jiraComments.id,
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
    const sprintState = parseSprintState(yield* getState(SYNC_KEYS.sprints));
    const blockers = parseBlockers(yield* getState(SYNC_KEYS.blockers));
    return {
      me,
      trackedEpics: settings.jira.trackedEpics,
      sprints: sprintState.sprints,
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
        requestedAt: x.requestedAt,
        lastFollowupAt: x.lastFollowupAt,
        ownerAway: x.ownerAway,
      })),
      comments: comments.map((c) => ({ ...c, mentionsMe: !!Number(c.mentionsMe) })),
      blockers,
    } satisfies DashboardInputs;
  });

/** Sprint > Epics (D50): the tracked epics' rollup, without building Today. */
export const loadEpicHealth = (now = new Date()) =>
  Effect.map(loadDashboardInputs(now), (input) => buildEpicHealth(input, localDate(now)));

/** Inbox proposals and questions waiting for the user, oldest first. */
const pendingInbox = query((d) =>
  d
    .select({
      inboxItemId: proposals.inboxItemId,
      kind: proposals.kind,
      createdAt: proposals.createdAt,
      summary: inboxItems.summary,
      sender: people.displayName,
      source: inboxItems.source,
    })
    .from(proposals)
    .innerJoin(inboxItems, eq(inboxItems.id, proposals.inboxItemId))
    .leftJoin(people, eq(people.id, inboxItems.senderPersonId))
    // A thread the user parked waits until it is back (D62).
    .where(and(eq(proposals.status, "pending"), ne(inboxItems.status, "parked")))
    .orderBy(asc(proposals.createdAt))
    .all(),
);

/** Everything Today is built from (D49): the ranking's snapshot plus woken tickets and the Inbox. */
export const loadTodayInputs = (now = new Date()) =>
  Effect.gen(function* () {
    const settings = yield* settingsOrDefault(yield* Settings);
    const base = yield* loadDashboardInputs(now);
    const woken = yield* loadWokenTickets(now);
    const pending = yield* pendingInbox;
    const home = settings.smallAsks;
    return {
      ...base,
      woken,
      // Outcome cards are rows of their own (Phase 25), not threads.
      threads: groupThreads(
        pending.flatMap((p) =>
          p.inboxItemId && p.source !== "secretary" ? [{ ...p, inboxItemId: p.inboxItemId }] : [],
        ),
      ),
      outcomes: yield* pendingOutcomes,
      smallAskLabel: home.projectKey && home.label.trim() ? home.label.trim() : null,
      workItems: yield* workByIssue,
    } satisfies TodayInputs;
  });

/** Today from the local cache (FR-12). */
export const loadToday = (now = new Date()) =>
  Effect.gen(function* () {
    const settings = yield* settingsOrDefault(yield* Settings);
    const input = yield* loadTodayInputs(now);
    return buildToday(input, settings.scoring, localDate(now), now.toISOString());
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

/** Hides an issue from Today until `until` (ISO timestamp); null wakes it. */
export const snooze = (issueKey: string, until: string | null) =>
  upsertMeta(issueKey, { snoozedUntil: until });

/** Local adjustment added to the ranking score; null clears it. */
export const setOverride = (issueKey: string, points: number | null) =>
  upsertMeta(issueKey, { priorityOverride: points });

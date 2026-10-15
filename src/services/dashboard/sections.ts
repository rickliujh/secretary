/**
 * Pure building blocks of Today (FR-12, D49) over one snapshot of the local
 * cache: block state from issue links, the epic rollup (Sprint > Epics), and
 * `rankWork`, the D29 focus ranking with due-soon, at-risk and new comments
 * that `buildToday` (today.ts) cuts its three lists from. The brief, the chat
 * tools, the report and the ticket picker read `rankWork` too.
 */
import { daysBetween } from "@/lib/dates";
import { type OwnerAway, timing } from "@/services/dependencies/logic";
import type { IssueLink as JiraIssueLink } from "@/services/jira/schemas";
import type { ScoringWeights } from "@/services/settings/schema";
import type { SprintInfo } from "@/services/sprints/calendar";
import { rank, type Scored, type ScoreInput, staleValue } from "./scoring";

export type IssueLink = Pick<JiraIssueLink, "type" | "inwardIssue" | "outwardIssue">;

export type DashIssue = {
  key: string;
  issueType: string;
  isSubtask: boolean;
  summary: string;
  status: string;
  statusCategory: "new" | "indeterminate" | "done";
  priority: string | null;
  assignee: string | null;
  assigneeDisplay: string | null;
  epicKey: string | null;
  /** The issue's current sprint name (active first), from the Sprint field. */
  sprint: string | null;
  dueDate: string | null;
  /** ISO time the issue was created; a small ask's age (D49). */
  created: string;
  updated: string;
  /** Jira labels; a small ask carries the home's label (D44). */
  labels: string[];
  links: IssueLink[];
  pinned: boolean;
  snoozedUntil: string | null;
  priorityOverride: number | null;
  lastViewedAt: string | null;
  /** Who asked, for a small ask (`issue_meta.requester_person_id`, D44). */
  requester: { id: string; name: string } | null;
};

export type DashDependency = {
  id: string;
  issueKey: string;
  label: string;
  externalRef: string | null;
  status: "open" | "waiting" | "blocked" | "resolved";
  expectedAt: string | null;
  nextFollowupAt: string | null;
  ownerName: string;
  /** For `timing` (D47): when it was opened, the last follow-up and the owner's away date. */
  requestedAt?: string | null;
  lastFollowupAt?: string | null;
  ownerAway?: OwnerAway | null;
};

export type RecentComment = {
  issueKey: string;
  author: string | null;
  authorDisplay: string | null;
  created: string;
  mentionsMe: boolean;
};

/** A sprint as sync stores it (D23); `userActiveSprints` needs the board, Top focus the state and end. */
export type DashSprint = Pick<SprintInfo, "name" | "state" | "end"> & Partial<SprintInfo>;

export type DashboardInputs = {
  me: string | null;
  trackedEpics: string[];
  /** Known sprints with their state and dates (D23), to find the active sprint. */
  sprints: DashSprint[];
  issues: DashIssue[];
  dependencies: DashDependency[];
  /** Comments from the last two weeks, newest first. */
  comments: RecentComment[];
  /** Blocker states read after sync (D45); they win over the status embedded in links. */
  blockers?: FreshStatuses;
};

/** One tracked epic's rollup over its cached children (FR-5.1; Sprint > Epics, D50). */
export type EpicHealth = {
  epic: DashIssue | null;
  key: string;
  total: number;
  done: number;
  inProgress: number;
  todo: number;
  blocked: number;
  stale: number;
};

export type FocusItem = DashIssue & Scored;
export type Flagged = { issue: DashIssue; reasons: string[] };

/**
 * What Top focus covers (D29): the user's work in the active sprint(s), or the
 * whole scope when none of it is in an active sprint.
 */
export type FocusScope =
  | { mode: "sprint"; sprints: string[]; endsOn: string | null }
  | { mode: "scope" };

/** The ranked view of the user's work that Today's lists are cut from. */
export type Work = {
  /** Top focus (D29), best first, at most `TOP_FOCUS_LIMIT`. */
  topFocus: FocusItem[];
  /** Every open, unsnoozed ticket in scope, best first; Today's Sprint work is cut from it. */
  ranked: FocusItem[];
  /** Keys Top focus may hold: the active sprint's work plus pins, or the whole scope. */
  focusKeys: ReadonlySet<string>;
  /** Open tickets with a comment or mention by someone else since the user last looked, newest first. */
  waitingOnMe: (Flagged & { at: string })[];
  /** Blocked, stale or late tickets in scope, most reasons first. */
  atRisk: Flagged[];
  /** Due within a week or late, soonest first. */
  dueSoon: (DashIssue & { daysLeft: number })[];
  /** Open tickets in scope that are snoozed now. */
  snoozed: number;
  inScope: number;
  focus: FocusScope;
};

export const TOP_FOCUS_LIMIT = 10;
const AT_RISK_IDLE_DAYS = 14;
const DUE_SOON_DAYS = 7;

const isBlockLink = (l: IssueLink) => /block/i.test(`${l.type.name} ${l.type.inward}`);

/** A blocker's state read after sync (D45 `jira.blockers`); preferred over the link's copy. */
export type FreshStatus = { statusCategory: string };
/** Fresh blocker states by key; missing keys fall back to the status embedded in the link. */
export type FreshStatuses = Readonly<Record<string, FreshStatus>>;

export type BlockLink = {
  /** Jira's link id, to delete it. */
  id: string | null;
  /** The other issue. */
  key: string;
  /** From this issue's side: it is blocked by `key`, or it blocks `key`. */
  direction: "blockedBy" | "blocks";
  /** The other issue's status category as embedded in the link. */
  statusCategory: string | null;
};

/** Every "blocks" link of an issue with its direction, whatever the other issue's status. */
export function blockLinks(links: readonly (IssueLink & { id?: string })[]): BlockLink[] {
  const out: BlockLink[] = [];
  for (const l of links) {
    if (!isBlockLink(l)) continue;
    const id = l.id ?? null;
    if (l.inwardIssue)
      out.push({
        id,
        key: l.inwardIssue.key,
        direction: "blockedBy",
        statusCategory: l.inwardIssue.fields?.status?.statusCategory.key ?? null,
      });
    if (l.outwardIssue)
      out.push({
        id,
        key: l.outwardIssue.key,
        direction: "blocks",
        statusCategory: l.outwardIssue.fields?.status?.statusCategory.key ?? null,
      });
  }
  return out;
}

/**
 * Unresolved blockers and blocked issues from Jira issue links. `fresh` holds
 * blocker states read after sync (D45), which win over the status Jira embedded
 * in the link when the linking issue was last fetched.
 */
export function blockInfo(
  links: readonly IssueLink[],
  fresh: FreshStatuses = {},
): { blockedBy: string[]; blocks: string[] } {
  const blockedBy: string[] = [];
  const blocks: string[] = [];
  for (const l of blockLinks(links)) {
    const category = fresh[l.key]?.statusCategory ?? l.statusCategory;
    if (category === "done") continue;
    (l.direction === "blockedBy" ? blockedBy : blocks).push(l.key);
  }
  return { blockedBy, blocks };
}

/** Done / in progress / to do per tracked epic, plus blocked and stale counts. */
export function buildEpicHealth(
  input: Pick<DashboardInputs, "trackedEpics" | "issues" | "blockers">,
  today: string,
): EpicHealth[] {
  const byKey = new Map(input.issues.map((i) => [i.key, i]));
  return input.trackedEpics.map((key) => {
    const children = input.issues.filter((i) => i.epicKey === key && !i.isSubtask);
    const count = (cat: DashIssue["statusCategory"]) =>
      children.filter((c) => c.statusCategory === cat).length;
    const openChildren = children.filter((c) => c.statusCategory !== "done");
    return {
      epic: byKey.get(key) ?? null,
      key,
      total: children.length,
      done: count("done"),
      inProgress: count("indeterminate"),
      todo: count("new"),
      blocked: openChildren.filter(
        (c) =>
          blockInfo(c.links, input.blockers).blockedBy.length > 0 ||
          /block|on hold/i.test(c.status),
      ).length,
      stale: openChildren.filter((c) => staleValue(c.updated, today).idle >= AT_RISK_IDLE_DAYS)
        .length,
    };
  });
}

/** How many due-soon, at-risk and waiting-on-me tickets the brief and the chat get. */
export const FACT_LIMIT = 8;

/**
 * Ranks the user's work (FR-5.1, FR-5.2, D29): what is in scope, Top focus,
 * new comments waiting on the user, at-risk and due-soon tickets. Lists are
 * complete; callers cut them.
 */
export function rankWork(
  input: DashboardInputs,
  weights: ScoringWeights,
  today: string,
  now: string,
): Work {
  const tracked = new Set(input.trackedEpics);
  const byKey = new Map(input.issues.map((i) => [i.key, i]));
  const depsByIssue = new Map<
    string,
    (DashDependency & { overdueDays: number; followupDue: boolean })[]
  >();
  for (const d of input.dependencies) {
    if (d.status === "resolved") continue;
    const t = timing(d, today);
    const list = depsByIssue.get(d.issueKey) ?? [];
    list.push({ ...d, overdueDays: t.overdueDays, followupDue: t.followupDue });
    depsByIssue.set(d.issueKey, list);
  }
  for (const list of depsByIssue.values()) list.sort((a, b) => b.overdueDays - a.overdueDays);

  const active = input.issues.filter((i) => i.statusCategory !== "done");
  const snoozedNow = (i: DashIssue) => !!i.snoozedUntil && i.snoozedUntil > now;
  const inScope = (i: DashIssue) =>
    (input.me !== null && i.assignee === input.me) ||
    i.pinned ||
    (!!i.epicKey && tracked.has(i.epicKey)) ||
    depsByIssue.has(i.key);
  // Epics are containers; Epic health covers them. Team-managed and localised
  // projects name the type differently, so anything that has children counts too.
  const epicKeys = new Set(input.issues.map((i) => i.epicKey).filter((k): k is string => !!k));
  const isEpic = (i: DashIssue) => /epic/i.test(i.issueType) || epicKeys.has(i.key);
  const scoped = active.filter((i) => inScope(i) && !isEpic(i));
  const blocks = new Map(scoped.map((i) => [i.key, blockInfo(i.links, input.blockers)]));

  // D29: when the user's work is in an active sprint, focus is that sprint's work
  // (plus anything pinned); the backlog does not compete with it.
  const activeSprints = new Map(
    input.sprints.filter((s) => s.state === "active").map((s) => [s.name, s]),
  );
  const unsnoozed = scoped.filter((i) => !snoozedNow(i));
  const inSprint = unsnoozed.filter((i) => !!i.sprint && activeSprints.has(i.sprint));
  const sprintNames = [...new Set(inSprint.map((i) => i.sprint as string))];
  const focus: FocusScope = inSprint.length
    ? {
        mode: "sprint",
        sprints: sprintNames,
        endsOn:
          sprintNames
            .map((n) => activeSprints.get(n)?.end ?? null)
            .filter((e): e is string => !!e)
            .sort()[0] ?? null,
      }
    : { mode: "scope" };
  const sprintKeys = new Set(inSprint.map((i) => i.key));
  const focusKeys = new Set(
    (focus.mode === "sprint"
      ? unsnoozed.filter((i) => sprintKeys.has(i.key) || i.pinned)
      : unsnoozed
    ).map((i) => i.key),
  );
  // Every unsnoozed ticket in scope is scored, so Today can cut Sprint work and
  // its due-soon and at-risk additions from one order; Top focus is the first
  // ten of those Top focus may hold.
  const ranked = rank(
    unsnoozed.map(
      (i): ScoreInput => ({
        key: i.key,
        priority: i.priority,
        dueDate: i.dueDate,
        updated: i.updated,
        statusName: i.status,
        blockedBy: blocks.get(i.key)?.blockedBy ?? [],
        blocks: blocks.get(i.key)?.blocks ?? [],
        dependencies: depsByIssue.get(i.key) ?? [],
        pinned: i.pinned,
        override: i.priorityOverride,
      }),
    ),
    weights,
    today,
  ).map((s) => ({ ...(byKey.get(s.key) as DashIssue), ...s }));
  const topFocus = ranked.filter((s) => focusKeys.has(s.key)).slice(0, TOP_FOCUS_LIMIT);

  // Waiting on me: my open issues with new comments from others, or any mention of me.
  const seen = new Set<string>();
  const waitingOnMe: Work["waitingOnMe"] = [];
  for (const c of input.comments) {
    if (seen.has(c.issueKey) || !input.me || c.author === input.me) continue;
    const issue = byKey.get(c.issueKey);
    if (!issue || issue.statusCategory === "done") continue;
    const unseen = !issue.lastViewedAt || c.created > issue.lastViewedAt;
    if (!unseen) continue;
    const who = c.authorDisplay ?? c.author ?? "Someone";
    if (c.mentionsMe) waitingOnMe.push({ issue, reasons: [`${who} mentioned you`], at: c.created });
    else if (issue.assignee === input.me)
      waitingOnMe.push({ issue, reasons: [`${who} commented`], at: c.created });
    else continue;
    seen.add(c.issueKey);
  }

  const atRisk: Flagged[] = [];
  for (const i of scoped) {
    const reasons: string[] = [];
    const b = blocks.get(i.key);
    if (b?.blockedBy.length) reasons.push(`Blocked by ${b.blockedBy.slice(0, 2).join(", ")}`);
    else if (/block|on hold/i.test(i.status)) reasons.push(`Status is ${i.status}`);
    const idle = staleValue(i.updated, today).idle;
    if (idle >= AT_RISK_IDLE_DAYS) reasons.push(`No updates for ${idle} days`);
    if (i.dueDate) {
      const left = daysBetween(today, i.dueDate);
      if (left < 0) reasons.push(`${-left} day${left === -1 ? "" : "s"} past due`);
      else if (left <= 3 && i.statusCategory === "new")
        reasons.push(`Due in ${left} day${left === 1 ? "" : "s"} and not started`);
    }
    const dep = depsByIssue.get(i.key)?.[0];
    if (dep && dep.overdueDays > 0)
      reasons.push(`Waiting on ${dep.label} (${dep.overdueDays}d overdue)`);
    if (reasons.length) atRisk.push({ issue: i, reasons });
  }
  atRisk.sort(
    (a, b) => b.reasons.length - a.reasons.length || a.issue.key.localeCompare(b.issue.key),
  );

  const dueSoon = scoped
    .filter((i) => i.dueDate && daysBetween(today, i.dueDate) <= DUE_SOON_DAYS)
    .map((i) => ({ ...i, daysLeft: daysBetween(today, i.dueDate ?? today) }))
    .sort((a, b) => a.daysLeft - b.daysLeft || a.key.localeCompare(b.key));

  return {
    topFocus,
    ranked,
    focusKeys,
    waitingOnMe,
    atRisk,
    dueSoon,
    snoozed: scoped.filter(snoozedNow).length,
    inScope: scoped.length,
    focus,
  };
}

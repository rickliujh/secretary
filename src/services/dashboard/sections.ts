/**
 * Pure dashboard section builders (FR-5.1). Input is one snapshot of the
 * local cache; output is what each card renders.
 */
import { daysBetween } from "@/lib/dates";
import { timing } from "@/services/dependencies/logic";
import type { IssueLink as JiraIssueLink } from "@/services/jira/schemas";
import type { ScoringWeights } from "@/services/settings/schema";
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
  dueDate: string | null;
  updated: string;
  links: IssueLink[];
  pinned: boolean;
  snoozedUntil: string | null;
  priorityOverride: number | null;
  lastViewedAt: string | null;
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
};

export type RecentComment = {
  issueKey: string;
  author: string | null;
  authorDisplay: string | null;
  created: string;
  mentionsMe: boolean;
};

export type DashboardInputs = {
  me: string | null;
  trackedEpics: string[];
  issues: DashIssue[];
  dependencies: DashDependency[];
  /** Comments from the last two weeks, newest first. */
  comments: RecentComment[];
};

export type FocusItem = DashIssue & Scored;
export type Flagged = { issue: DashIssue; reasons: string[] };

export type Dashboard = {
  topFocus: FocusItem[];
  waitingOnMe: (Flagged & { at: string })[];
  iAmWaitingOn: (DashDependency & {
    overdueDays: number;
    followupDue: boolean;
    issueSummary: string | null;
  })[];
  atRisk: Flagged[];
  dueSoon: (DashIssue & { daysLeft: number })[];
  epicHealth: {
    epic: DashIssue | null;
    key: string;
    total: number;
    done: number;
    inProgress: number;
    todo: number;
    blocked: number;
    stale: number;
  }[];
  snoozed: number;
  inScope: number;
};

export const TOP_FOCUS_LIMIT = 10;
const SECTION_LIMIT = 8;
const AT_RISK_IDLE_DAYS = 14;
const DUE_SOON_DAYS = 7;

const isBlockLink = (l: IssueLink) => /block/i.test(`${l.type.name} ${l.type.inward}`);
const open = (i: NonNullable<IssueLink["inwardIssue"]>) =>
  i.fields?.status?.statusCategory.key !== "done";

/** Unresolved blockers and blocked issues from Jira issue links. */
export function blockInfo(links: readonly IssueLink[]): { blockedBy: string[]; blocks: string[] } {
  const blockedBy: string[] = [];
  const blocks: string[] = [];
  for (const l of links) {
    if (!isBlockLink(l)) continue;
    if (l.inwardIssue && open(l.inwardIssue)) blockedBy.push(l.inwardIssue.key);
    if (l.outwardIssue && open(l.outwardIssue)) blocks.push(l.outwardIssue.key);
  }
  return { blockedBy, blocks };
}

export function buildDashboard(
  input: DashboardInputs,
  weights: ScoringWeights,
  today: string,
  now: string,
): Dashboard {
  const tracked = new Set(input.trackedEpics);
  const byKey = new Map(input.issues.map((i) => [i.key, i]));
  const openDeps = input.dependencies.filter((d) => d.status !== "resolved");
  const depsByIssue = new Map<
    string,
    (DashDependency & { overdueDays: number; followupDue: boolean })[]
  >();
  for (const d of openDeps) {
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
  const scoped = active.filter((i) => inScope(i) && i.issueType !== "Epic");
  const blocks = new Map(scoped.map((i) => [i.key, blockInfo(i.links)]));

  const focusCandidates = scoped.filter((i) => !snoozedNow(i));
  const scores = rank(
    focusCandidates.map(
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
  );
  const topFocus = scores
    .slice(0, TOP_FOCUS_LIMIT)
    .map((s) => ({ ...(byKey.get(s.key) as DashIssue), ...s }));

  // Waiting on me: my open issues with new comments from others, or any mention of me.
  const seen = new Set<string>();
  const waitingOnMe: Dashboard["waitingOnMe"] = [];
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

  const iAmWaitingOn = openDeps
    .map((d) => {
      const t = timing(d, today);
      return {
        ...d,
        overdueDays: t.overdueDays,
        followupDue: t.followupDue,
        issueSummary: byKey.get(d.issueKey)?.summary ?? null,
      };
    })
    .filter((d) => d.overdueDays > 0 || d.followupDue)
    .sort((a, b) => b.overdueDays - a.overdueDays || Number(b.followupDue) - Number(a.followupDue));

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

  const epicHealth = input.trackedEpics.map((key) => {
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
        (c) => blockInfo(c.links).blockedBy.length > 0 || /block|on hold/i.test(c.status),
      ).length,
      stale: openChildren.filter((c) => staleValue(c.updated, today).idle >= AT_RISK_IDLE_DAYS)
        .length,
    };
  });

  return {
    topFocus,
    waitingOnMe: waitingOnMe.slice(0, SECTION_LIMIT),
    iAmWaitingOn,
    atRisk: atRisk.slice(0, SECTION_LIMIT),
    dueSoon: dueSoon.slice(0, SECTION_LIMIT),
    epicHealth,
    snoozed: scoped.filter(snoozedNow).length,
    inScope: scoped.length,
  };
}

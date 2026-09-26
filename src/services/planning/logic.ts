/**
 * Sprint planning, the deterministic part (design.md D30): which sprint is next,
 * how much the user usually finishes, and which issues are worth considering.
 * The model only chooses among the candidates this module builds.
 */
import type { SprintInfo } from "@/services/sprints/calendar";

/** One issue as the planner sees it. */
export type PlanIssue = {
  key: string;
  summary: string;
  issueType: string;
  status: string;
  statusCategory: "new" | "indeterminate" | "done";
  priority: string | null;
  storyPoints: number | null;
  assignee: string | null;
  epicKey: string | null;
  sprint: string | null;
  dueDate: string | null;
  /** When it was resolved (ISO), for velocity. */
  resolved: string | null;
  /** Open blockers and dependencies, to flag risk. */
  blockedBy: string[];
  waitingOn: { label: string; expectedAt: string | null }[];
  /** Focus score (dashboard ranking); higher first. */
  score: number;
};

export type CandidateGroup = "carry_over" | "planned" | "backlog" | "pickup";

export type Candidate = {
  key: string;
  summary: string;
  group: CandidateGroup;
  issueType: string;
  status: string;
  priority: string | null;
  points: number | null;
  dueDate: string | null;
  epicKey: string | null;
  blocked: string[];
  /** Due before the next sprint ends. */
  dueInSprint: boolean;
};

export type Velocity = {
  sprints: { name: string; points: number; issues: number; unestimated: number }[];
  /** Average completed points per sprint; null without closed sprints to learn from. */
  average: number | null;
};

const MAX_BACKLOG = 25;
const MAX_PICKUPS = 10;
const VELOCITY_SPRINTS = 3;

const isEpic = (i: PlanIssue, epicKeys: ReadonlySet<string>) =>
  /epic/i.test(i.issueType) || epicKeys.has(i.key);

/** The active sprint holding the user's work, and the board's next future sprint. */
export function sprintPair(
  sprints: readonly SprintInfo[],
  issues: readonly PlanIssue[],
  me: string,
) {
  const mineIn = new Set(issues.filter((i) => i.assignee === me && i.sprint).map((i) => i.sprint));
  const actives = sprints.filter((s) => s.state === "active");
  const active = actives.find((s) => mineIn.has(s.name)) ?? actives[0] ?? null;
  const board = active?.boardId ?? null;
  const next =
    sprints
      .filter((s) => s.state === "future" && (board === null || s.boardId === board))
      .sort((a, b) => (a.start ?? "9999").localeCompare(b.start ?? "9999") || a.id - b.id)[0] ??
    null;
  return { active, next };
}

/**
 * Points the user finished in the board's last closed sprints: their issues
 * resolved between each sprint's start and end.
 */
export function velocity(
  sprints: readonly SprintInfo[],
  issues: readonly PlanIssue[],
  me: string,
  boardId: number | null,
): Velocity {
  const closed = sprints
    .filter(
      (s) =>
        s.state === "closed" && s.start && s.end && (boardId === null || s.boardId === boardId),
    )
    .sort((a, b) => (b.end ?? "").localeCompare(a.end ?? ""))
    .slice(0, VELOCITY_SPRINTS);
  const mine = issues.filter((i) => i.assignee === me && i.resolved);
  const rows = closed.map((s) => {
    const done = mine.filter((i) => {
      const day = (i.resolved ?? "").slice(0, 10);
      return day >= (s.start ?? "") && day <= (s.end ?? "");
    });
    return {
      name: s.name,
      points: done.reduce((n, i) => n + (i.storyPoints ?? 0), 0),
      issues: done.length,
      unestimated: done.filter((i) => i.storyPoints === null).length,
    };
  });
  const average = rows.length
    ? Math.round((rows.reduce((n, r) => n + r.points, 0) / rows.length) * 10) / 10
    : null;
  return { sprints: rows, average };
}

/**
 * Issues worth considering for the next sprint, in groups: the user's unfinished
 * work in the active sprint, their issues already in the next sprint, their
 * backlog ranked by the focus score, and unassigned issues under tracked epics.
 * Epics are never candidates.
 */
export function buildCandidates(opts: {
  issues: readonly PlanIssue[];
  me: string;
  active: SprintInfo | null;
  next: SprintInfo | null;
  trackedEpics: readonly string[];
}): Candidate[] {
  const { issues, me, active, next } = opts;
  const epicKeys = new Set(issues.map((i) => i.epicKey).filter((k): k is string => !!k));
  const tracked = new Set(opts.trackedEpics);
  const open = issues.filter((i) => i.statusCategory !== "done" && !isEpic(i, epicKeys));
  const nextEnd = next?.end ?? null;
  const toCandidate = (i: PlanIssue, group: CandidateGroup): Candidate => ({
    key: i.key,
    summary: i.summary,
    group,
    issueType: i.issueType,
    status: i.status,
    priority: i.priority,
    points: i.storyPoints,
    dueDate: i.dueDate,
    epicKey: i.epicKey,
    blocked: [...i.blockedBy, ...i.waitingOn.map((w) => w.label)],
    dueInSprint: !!i.dueDate && !!nextEnd && i.dueDate <= nextEnd,
  });
  const mine = open.filter((i) => i.assignee === me);
  const carry = active ? mine.filter((i) => i.sprint === active.name) : [];
  const planned = next ? mine.filter((i) => i.sprint === next.name) : [];
  const taken = new Set([...carry, ...planned].map((i) => i.key));
  const inAnySprint = (i: PlanIssue) =>
    !!i.sprint && (i.sprint === active?.name || i.sprint === next?.name);
  const backlog = mine
    .filter((i) => !taken.has(i.key) && !inAnySprint(i))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_BACKLOG);
  const pickups = open
    .filter((i) => i.assignee === null && !!i.epicKey && tracked.has(i.epicKey) && !inAnySprint(i))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_PICKUPS);
  return [
    ...carry.map((i) => toCandidate(i, "carry_over")),
    ...planned.map((i) => toCandidate(i, "planned")),
    ...backlog.map((i) => toCandidate(i, "backlog")),
    ...pickups.map((i) => toCandidate(i, "pickup")),
  ];
}

/** Total points of the given keys; unestimated issues count as zero and are listed. */
export function pointsOf(candidates: readonly Candidate[], keys: readonly string[]) {
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  let total = 0;
  const unestimated: string[] = [];
  for (const k of keys) {
    const c = byKey.get(k);
    if (!c) continue;
    if (c.points === null) unestimated.push(k);
    else total += c.points;
  }
  return { total, unestimated };
}

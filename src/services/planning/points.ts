/**
 * Story point totals for a sprint (D35), for chat and anywhere else that asks
 * "how many points do I have". Computed in code; the model only reports them.
 */
import type { SprintInfo } from "@/services/sprints/calendar";

export type PointsIssue = {
  key: string;
  summary: string;
  issueType: string;
  isSubtask: boolean;
  status: string;
  statusCategory: "new" | "indeterminate" | "done";
  assignee: string | null;
  assigneeDisplay: string | null;
  sprint: string | null;
  storyPoints: number | null;
};

export type SprintPoints = {
  total: number;
  done: number;
  remaining: number;
  /** Tickets with an estimate (zero counts as an estimate). */
  estimated: number;
  /** Tickets in the sprint without an estimate. */
  unestimated: string[];
  tickets: {
    key: string;
    summary: string;
    status: string;
    assignee: string | null;
    points: number | null;
  }[];
};

/**
 * Points of the sprint's tickets, optionally one assignee's. Sub-tasks and epics
 * are left out, as Jira's sprint reports do.
 */
export function sprintPoints(
  issues: readonly PointsIssue[],
  sprint: string,
  assignee: string | null,
): SprintPoints {
  const inSprint = issues.filter(
    (i) =>
      i.sprint === sprint &&
      !i.isSubtask &&
      !/epic/i.test(i.issueType) &&
      (assignee === null || i.assignee === assignee),
  );
  let total = 0;
  let done = 0;
  for (const i of inSprint) {
    total += i.storyPoints ?? 0;
    if (i.statusCategory === "done") done += i.storyPoints ?? 0;
  }
  return {
    total,
    done,
    remaining: total - done,
    estimated: inSprint.filter((i) => i.storyPoints !== null).length,
    unestimated: inSprint.filter((i) => i.storyPoints === null).map((i) => i.key),
    tickets: inSprint
      .sort((a, b) => (b.storyPoints ?? -1) - (a.storyPoints ?? -1) || a.key.localeCompare(b.key))
      .map((i) => ({
        key: i.key,
        summary: i.summary,
        status: i.status,
        assignee: i.assigneeDisplay,
        points: i.storyPoints,
      })),
  };
}

/**
 * The sprint a question means: one named (exact, then partial, case-insensitive),
 * else the active sprint holding the user's work, else any active sprint.
 */
export function pickSprint(
  sprints: readonly SprintInfo[],
  issues: readonly PointsIssue[],
  me: string | null,
  name?: string,
): SprintInfo | null {
  const wanted = name?.trim().toLowerCase();
  if (wanted) {
    return (
      sprints.find((s) => s.name.toLowerCase() === wanted) ??
      sprints.find((s) => s.name.toLowerCase().includes(wanted)) ??
      null
    );
  }
  const mine = new Set(issues.filter((i) => me && i.assignee === me).map((i) => i.sprint));
  const actives = sprints.filter((s) => s.state === "active");
  return actives.find((s) => mine.has(s.name)) ?? actives[0] ?? null;
}

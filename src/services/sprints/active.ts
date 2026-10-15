/**
 * The user's active sprint, found the same way everywhere: the active sprint
 * holding most of the user's open issues (D29, D30, D44).
 */
import type { SprintInfo } from "./calendar";

export type SprintIssue = {
  assignee: string | null;
  sprint: string | null;
  /** Done issues do not count; absent means open. */
  statusCategory?: string;
  projectKey?: string;
};

/**
 * Active sprints that hold the user's open issues, most first (ties keep the
 * order of `sprints`). `preferProject` puts sprints on a board that shows that
 * project first, so a small ask lands on a board that can hold it (D44).
 */
export function userActiveSprints(
  sprints: readonly SprintInfo[],
  issues: readonly SprintIssue[],
  me: string | null,
  opts: {
    preferProject?: string;
    boardProjects?: Readonly<Record<string, readonly string[]>>;
  } = {},
): SprintInfo[] {
  if (!me) return [];
  // Open issues decide; finished ones only break ties, so a sprint whose work is
  // all done near its end still counts as the user's.
  const open = new Map<string, number>();
  const all = new Map<string, number>();
  for (const i of issues) {
    if (i.assignee !== me || !i.sprint) continue;
    all.set(i.sprint, (all.get(i.sprint) ?? 0) + 1);
    if (i.statusCategory !== "done") open.set(i.sprint, (open.get(i.sprint) ?? 0) + 1);
  }
  const onBoard = (s: SprintInfo) =>
    !!opts.preferProject &&
    s.boardId !== null &&
    (opts.boardProjects?.[String(s.boardId)] ?? []).includes(opts.preferProject);
  return sprints
    .map((s, i) => ({ s, i, open: open.get(s.name) ?? 0, all: all.get(s.name) ?? 0 }))
    .filter((x) => x.s.state === "active" && x.all > 0)
    .sort(
      (a, b) =>
        Number(onBoard(b.s)) - Number(onBoard(a.s)) ||
        b.open - a.open ||
        b.all - a.all ||
        a.i - b.i,
    )
    .map((x) => x.s);
}

/** The active sprint holding most of the user's open work, else any active sprint, else null. */
export function userActiveSprint(
  sprints: readonly SprintInfo[],
  issues: readonly SprintIssue[],
  me: string | null,
): SprintInfo | null {
  return (
    userActiveSprints(sprints, issues, me)[0] ?? sprints.find((s) => s.state === "active") ?? null
  );
}

type BoardProjects = Readonly<Record<string, readonly string[]>>;

/** Whether the sprint's board shows issues of `projectKey` (from synced issues, D23). */
export const boardShowsProject = (
  sprint: Pick<SprintInfo, "boardId">,
  projectKey: string,
  boardProjects: BoardProjects,
) => sprint.boardId !== null && (boardProjects[String(sprint.boardId)] ?? []).includes(projectKey);

/**
 * The sprint a new ticket of `projectKey` joins (D44, D57): one pick for the
 * Executor, the Inbox card and payload defaults. Null when no active sprint
 * holds the user's work.
 */
export function joinSprintFor(
  sprints: readonly SprintInfo[],
  issues: readonly SprintIssue[],
  me: string | null,
  projectKey: string,
  boardProjects: BoardProjects,
): SprintInfo | null {
  return (
    userActiveSprints(sprints, issues, me, { preferProject: projectKey, boardProjects })[0] ?? null
  );
}

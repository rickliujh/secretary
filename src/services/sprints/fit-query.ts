/**
 * Sprint fit reads (FR-16, D57) for the Inbox cards, Today, Settings and chat:
 * the cache, settings and a thread's pending proposals. The decisions are in
 * `fit.ts`; the sprint pick is the Executor's (`joinSprintFor`).
 */
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { Effect } from "effect";
import { jiraIssues, proposals } from "@/db/schema";
import { localDate } from "@/lib/dates";
import { query } from "@/services/db";
import { velocity } from "@/services/planning/logic";
import { effectivePayload, type PayloadOf } from "@/services/proposals/schema";
import { Settings, settingsOrDefault } from "@/services/settings";
import { isSubtaskType } from "@/services/small-asks/home";
import { getState, parseProjectMeta, parseSprintState, SYNC_KEYS } from "@/services/sync/state";
import { boardShowsProject, joinSprintFor, userActiveSprints } from "./active";
import type { SprintInfo } from "./calendar";
import {
  chooseRate,
  type Fit,
  type FitTicket,
  type LastDayMode,
  type LoadIssue,
  type Rate,
  sprintFit,
  sprintWhen,
  userLoad,
  velocityRate,
  workingDaysLeft,
} from "./fit";

type MyIssue = LoadIssue & { resolved: string | null };

/** What every fit needs, read once. */
export const fitData = Effect.gen(function* () {
  const settings = yield* settingsOrDefault(yield* Settings);
  const me = (yield* getState(SYNC_KEYS.username)) ?? null;
  const state = parseSprintState(yield* getState(SYNC_KEYS.sprints));
  const projectMeta = parseProjectMeta(yield* getState(SYNC_KEYS.projectMeta));
  const mine: MyIssue[] = me
    ? yield* query((d) =>
        d
          .select({
            assignee: jiraIssues.assignee,
            sprint: jiraIssues.sprint,
            statusCategory: jiraIssues.statusCategory,
            issueType: jiraIssues.issueType,
            isSubtask: jiraIssues.isSubtask,
            storyPoints: jiraIssues.storyPoints,
            resolved: jiraIssues.resolved,
          })
          .from(jiraIssues)
          .where(and(eq(jiraIssues.assignee, me), eq(jiraIssues.stale, false)))
          .all(),
      )
    : [];
  return {
    me,
    state,
    projectMeta,
    mine,
    daysPerPoint: settings.sprint.daysPerPoint,
    lastDay: settings.sprint.lastDay,
  };
});
export type FitData = Effect.Effect.Success<typeof fitData>;

/** The rate on a board: Settings, else the user's velocity there (D30), else none. */
export function rateOn(
  data: FitData,
  boardId: number | null,
): { rate: Rate | null; derived: Rate | null } {
  const derived = data.me
    ? velocityRate(velocity(data.state.sprints, data.mine, data.me, boardId).sprints, data.lastDay)
    : null;
  return { rate: chooseRate(data.daysPerPoint, derived), derived };
}

/** A sprint as the cards show it. */
export type SprintView = {
  id: number;
  name: string;
  start: string | null;
  end: string | null;
  /** "ends Fri 17 Oct, 3 working days left" or "ended Tue 14 Oct, not closed yet". */
  when: string;
  daysLeft: number;
  ended: boolean;
  /** Jira's end timestamp, for Settings' example of how the last day counts. */
  endAt: string | null;
};

const viewOf = (s: SprintInfo, today: string, mode: LastDayMode): SprintView => ({
  id: s.id,
  name: s.name,
  start: s.start,
  end: s.end,
  when: sprintWhen(s, today, mode),
  daysLeft: workingDaysLeft(s, today, mode),
  endAt: s.endAt ?? null,
  // Past its end while Jira still has it active: "ended, not closed yet".
  ended: s.state === "active" && !!s.end && s.end.slice(0, 10) < today,
});

/** The user's load in a sprint, with or without new tickets (D57). */
export function loadFit(
  data: FitData,
  sprint: SprintInfo,
  today: string,
  extra: { others?: FitTicket[]; ticket?: FitTicket | null } = {},
): Fit {
  const view = viewOf(sprint, today, data.lastDay);
  return sprintFit({
    daysLeft: view.daysLeft,
    ended: view.ended,
    load: userLoad(data.mine, sprint.name, data.me),
    others: extra.others ?? [],
    ticket: extra.ticket ?? null,
    rate: rateOn(data, sprint.boardId).rate,
    me: data.me,
  });
}

/** A create's sprint choice on its card (D57). */
export type CreateSprintFit =
  /** An Epic or a sub-task: no switch (sub-tasks follow their parent). */
  | { kind: "never" }
  /** No active sprint holds the user's work: it goes to the backlog. */
  | { kind: "no_sprint" }
  | {
      kind: "sprint";
      sprint: SprintView;
      /** The sprint's board does not show the ticket's project, so it will not appear there. */
      offBoard: boolean;
      fit: Fit;
    };

type Create = PayloadOf<"create_issue">;

/**
 * Sprint choices of a thread's open creates, by proposal id. Others that count
 * are the thread's other pending creates with `joinSprint` on that would land
 * in the same sprint.
 */
export const threadSprintFits = (inboxItemId: string, today = localDate()) =>
  Effect.gen(function* () {
    const rows = yield* query((d) =>
      d
        .select()
        .from(proposals)
        .where(and(eq(proposals.inboxItemId, inboxItemId), eq(proposals.kind, "create_issue")))
        .all(),
    );
    const open = rows
      .filter((r) => r.status === "pending" || r.status === "failed")
      .map((r) => ({ id: r.id, status: r.status, p: effectivePayload(r) }))
      .filter(
        (r): r is { id: string; status: typeof r.status; p: Create } => r.p.kind === "create_issue",
      );
    if (!open.length) return {} as Record<string, CreateSprintFit>;
    const data = yield* fitData;
    const never = (p: Create) =>
      /^epic$/i.test(p.issueType.trim()) ||
      isSubtaskType(p.issueType, data.projectMeta[p.projectKey]?.subtaskTypes ?? null);
    const sprintOf = (p: Create) =>
      joinSprintFor(data.state.sprints, data.mine, data.me, p.projectKey, data.state.boardProjects);
    // Names for assignees other than the user: a Cloud account id means nothing to read.
    const others = [
      ...new Set(open.map((o) => o.p.assignee).filter((a): a is string => !!a && a !== data.me)),
    ];
    const names = new Map(
      others.length
        ? (yield* query((d) =>
            d
              .selectDistinct({ id: jiraIssues.assignee, name: jiraIssues.assigneeDisplay })
              .from(jiraIssues)
              .where(
                and(inArray(jiraIssues.assignee, others), isNotNull(jiraIssues.assigneeDisplay)),
              )
              .all(),
          )).map((r) => [r.id, r.name] as const)
        : [],
    );
    const ticketOf = (p: Create): FitTicket => ({
      label: p.summary,
      points: p.storyPoints,
      assignee: p.assignee,
      assigneeName: p.assignee ? (names.get(p.assignee) ?? null) : null,
    });
    const out: Record<string, CreateSprintFit> = {};
    for (const c of open) {
      if (never(c.p)) {
        out[c.id] = { kind: "never" };
        continue;
      }
      const sprint = sprintOf(c.p);
      if (!sprint) {
        out[c.id] = { kind: "no_sprint" };
        continue;
      }
      const joining = open
        .filter(
          (o) =>
            o.id !== c.id &&
            o.status === "pending" &&
            o.p.joinSprint &&
            !never(o.p) &&
            sprintOf(o.p)?.id === sprint.id,
        )
        .map((o) => ticketOf(o.p));
      out[c.id] = {
        kind: "sprint",
        sprint: viewOf(sprint, today, data.lastDay),
        offBoard: !boardShowsProject(sprint, c.p.projectKey, data.state.boardProjects),
        fit: loadFit(data, sprint, today, { others: joining, ticket: ticketOf(c.p) }),
      };
    }
    return out;
  });

/** The synced sprints and the projects each board shows, for the Edit dialog's Sprint select (D58). */
export const knownSprints = Effect.map(getState(SYNC_KEYS.sprints), parseSprintState);

/**
 * The sprint the Edit dialog's switch adds a ticket of `projectKey` to (D58):
 * the same pick as a proposal's switch and the Executor (`joinSprintFor`), with
 * its dates, and `offBoard` when its board does not show the project, as the
 * proposal card warns. Null when no active sprint holds the user's work.
 */
export const ticketJoinSprint = (projectKey: string, today = localDate()) =>
  Effect.gen(function* () {
    const data = yield* fitData;
    const sprint = joinSprintFor(
      data.state.sprints,
      data.mine,
      data.me,
      projectKey,
      data.state.boardProjects,
    );
    if (!sprint) return null;
    return {
      ...viewOf(sprint, today, data.lastDay),
      offBoard: !boardShowsProject(sprint, projectKey, data.state.boardProjects),
    };
  });

/**
 * The fit of an existing ticket moving into an active sprint from the Edit
 * dialog (FR-17.3, D58): the user's open tickets there plus this ticket with
 * the dialog's points, counted toward the user when its assignee is the user or
 * empty. Null unless the sprint is known and active, and for a sprint named
 * like the ticket's cached one (`currentSprint`): the load counts tickets by
 * sprint name, so it may hold this one already.
 */
export const ticketSprintFit = (
  sprintId: number,
  ticket: FitTicket,
  today = localDate(),
  currentSprint: string | null = null,
) =>
  Effect.gen(function* () {
    const data = yield* fitData;
    const sprint = data.state.sprints.find((s) => s.id === sprintId && s.state === "active");
    if (!sprint || sprint.name === currentSprint) return null;
    return {
      sprint: viewOf(sprint, today, data.lastDay),
      fit: loadFit(data, sprint, today, { ticket }),
    };
  });
export type TicketSprintFit = Effect.Effect.Success<ReturnType<typeof ticketSprintFit>>;

/**
 * The user's sprint and its load without a new ticket, for Today and Settings
 * (D57). `derived` is the velocity rate on that board, shown when the setting
 * is empty.
 */
export const userSprintLoad = (today = localDate()) =>
  Effect.gen(function* () {
    const data = yield* fitData;
    const sprint = userActiveSprints(data.state.sprints, data.mine, data.me)[0] ?? null;
    const { derived } = rateOn(data, sprint?.boardId ?? null);
    if (!sprint) return { sprint: null, fit: null, derived };
    return {
      sprint: viewOf(sprint, today, data.lastDay),
      fit: loadFit(data, sprint, today),
      derived,
    };
  });
export type UserSprintLoad = Effect.Effect.Success<ReturnType<typeof userSprintLoad>>;

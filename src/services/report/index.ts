/**
 * Recap report (design.md D37): what was done, what is in progress, what is new
 * or changed, and what is next, over a period the user picks, for stand-ups and
 * catch-up meetings. Facts come from code (the cache plus Jira change history);
 * one model call writes them up.
 */
import { Context, Data, type Effect } from "effect";
import type { DbError } from "@/services/db";
import type { LlmError } from "@/services/llm";

export class ReportError extends Data.TaggedError("ReportError")<{
  /** no_user: Jira not synced yet. */
  readonly kind: "no_user";
  readonly message: string;
}> {}

/**
 * `workday`: since the start of the previous working day (Monday looks back to
 * Friday). `days`: since local midnight that many days ago (1 = yesterday).
 * Either way the period runs until now.
 */
export type ReportPeriod = { kind: "workday" } | { kind: "days"; days: number };

/** The user's own work, or that plus the tracked epics' tickets. */
export type ReportScope = "mine" | "mine_and_tracked";

export type ReportRequest = {
  period: ReportPeriod;
  scope: ReportScope;
  /** Only tickets in the active sprint (D40); default true. No effect without one. */
  sprintOnly?: boolean;
};

/** How a report reads (D39); every style is built from the same report data. */
export const REPORT_STYLES = ["talk_track", "standup", "by_epic", "timeline"] as const;
export type ReportStyle = (typeof REPORT_STYLES)[number];

export type ReportGroup = "done" | "in_progress" | "new" | "changed" | "blocked" | "next";

/** Something that happened to a ticket in the period, from Jira history, comments or follow-ups. */
export type ReportEvent = {
  at: string;
  kind: "created" | "assigned" | "status" | "field" | "comment" | "resolved" | "followup";
  /** "you", a display name, or "someone". */
  by: string;
  /**
   * Short text: "In Progress -> In Review", "Priority: Medium -> High",
   * a comment's first words (someone else's text), or a follow-up's summary.
   */
  text: string;
};

/** Something the ticket waits on, from the Waiting-on page. */
export type ReportDependency = {
  label: string;
  owner: string;
  externalRef: string | null;
  status: "open" | "waiting" | "blocked";
  /** When it was asked for (YYYY-MM-DD or ISO), when known. */
  since: string | null;
  expectedAt: string | null;
  overdueDays: number;
  lastFollowup: { at: string; channel: string | null; summary: string | null } | null;
  nextFollowupAt: string | null;
  followupDue: boolean;
};

export type ReportTicket = {
  key: string;
  summary: string;
  status: string;
  statusCategory: "new" | "indeterminate" | "done";
  points: number | null;
  group: ReportGroup;
  epic: { key: string; name: string } | null;
  dueDate: string | null;
  /** Short facts from code, e.g. "Blocked by OPS-7", "Due 2 Oct". */
  notes: string[];
  /** Oldest first. */
  events: ReportEvent[];
  dependencies: ReportDependency[];
  /** Why someone waits on the user here ("Ana mentioned you"), or null. */
  waitingOnMe: string | null;
  /** The model's line on what happened (comments, decisions); "" when nothing. */
  happened: string;
  /** The model's next step; "" when none. */
  next: string;
};

/** Progress of an epic the report's tickets belong to, over all its cached children. */
export type ReportEpic = { key: string; name: string; done: number; total: number };

export type SprintHealth = {
  name: string;
  endsOn: string | null;
  /** Working day of the sprint (1-based) and its length, when the dates are known. */
  day: number | null;
  days: number | null;
  /** The user's tickets in the sprint. */
  pointsDone: number;
  pointsTotal: number;
  pointsInReview: number;
  pointsBlocked: number;
  unestimated: string[];
};

export type Report = {
  generatedAt: string;
  /** Period start and end, ISO. */
  since: string;
  until: string;
  /** e.g. "Since Friday" or "Last 7 days". */
  periodLabel: string;
  scope: ReportScope;
  /** The active sprints the report was limited to; empty when it was not limited. */
  sprintScope: string[];
  /** A 20-second first-person script to read out. */
  talkTrack: string;
  /** One sentence: the period's headline. */
  headline: string;
  tickets: ReportTicket[];
  epics: ReportEpic[];
  sprint: SprintHealth | null;
  /** From code: blocked work in the sprint, due dates at risk, points behind time. */
  risks: string[];
  /** People waiting on the user: questions, mentions, unseen comments. */
  asks: { key: string; who: string; what: string; at: string }[];
  stats: {
    done: number;
    pointsDone: number;
    inProgress: number;
    new: number;
    comments: number;
  };
  /** Tickets whose Jira history could not be fetched (offline, errors); cache-only facts for them. */
  historyMissing: string[];
  model: string | null;
};

export interface ReportsShape {
  readonly generate: (
    req: ReportRequest,
  ) => Effect.Effect<Report, ReportError | LlmError | DbError>;
  /** The last report generated, kept until the next one. */
  readonly last: Effect.Effect<Report | null, DbError>;
}

export class Reports extends Context.Tag("Reports")<Reports, ReportsShape>() {}

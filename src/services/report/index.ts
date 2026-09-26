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

export type ReportRequest = { period: ReportPeriod; scope: ReportScope };

/** Markdown the model wrote over the facts; each may be "" when there is nothing. */
export type ReportSections = {
  /** One or two sentences: the headline of the period. */
  summary: string;
  done: string;
  inProgress: string;
  /** New tickets, new assignments, status moves, notable comments. */
  changes: string;
  blockers: string;
  next: string;
};

export type ReportGroup = "done" | "in_progress" | "new" | "changed" | "blocked" | "next";

/** A ticket the report is based on, for the list under the prose. */
export type ReportTicket = {
  key: string;
  summary: string;
  status: string;
  points: number | null;
  group: ReportGroup;
  /** Short facts from code, e.g. "In Progress -> In Review, 25 Sep". */
  notes: string[];
};

export type Report = {
  generatedAt: string;
  /** Period start and end, ISO. */
  since: string;
  until: string;
  /** e.g. "Since Friday" or "Last 7 days". */
  periodLabel: string;
  scope: ReportScope;
  sections: ReportSections;
  tickets: ReportTicket[];
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

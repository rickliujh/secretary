import { Context, Data, type Effect } from "effect";
import type { DbError } from "@/services/db";
import type { JiraError } from "@/services/jira";
import type { ProposalPayload } from "@/services/proposals/schema";
import type { JiraAction } from "./actions";

export * from "./actions";

export class ExecutorError extends Data.TaggedError("ExecutorError")<{
  readonly kind: "invalid" | "unsupported";
  readonly message: string;
}> {}

export type ExecutionResult = {
  actionLogId: string;
  response: unknown;
  /** False when the write succeeded but the re-fetch failed; the next sync repairs it. */
  refreshed: boolean;
};

export type ProposalResult = {
  message: string;
  issueKey?: string;
  dependencyId?: string;
  memoryId?: string;
  communicationId?: string;
};

export interface ExecutorShape {
  /**
   * Executes one approved proposal (design.md 7.3). `$new` refs must already
   * be resolved to issue keys.
   */
  readonly runProposal: (
    payload: ProposalPayload,
    opts: { proposalId: string; inboxItemId: string | null },
  ) => Effect.Effect<ProposalResult, ExecutorError | JiraError | DbError>;
  /**
   * The only path that writes to Jira (CLAUDE.md hard rule). Callers pass an
   * action the user explicitly triggered or approved.
   */
  readonly run: (
    action: JiraAction,
    opts?: { proposalId?: string },
  ) => Effect.Effect<ExecutionResult, ExecutorError | JiraError | DbError>;
}

export class Executor extends Context.Tag("Executor")<Executor, ExecutorShape>() {}

import { Context, Data, type Effect } from "effect";
import type { DbError } from "@/services/db";
import type { JiraError } from "@/services/jira";
import type { ProposalPayload } from "@/services/proposals/schema";
import type { JiraAction } from "./actions";
import type { ReverseOp } from "./reverse";
import type { Undo } from "./undo";

export * from "./actions";
export * from "./reverse";
export * from "./undo";

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
  /** Something that did not happen though the proposal ran, e.g. a failed sprint move (D44). */
  warning?: string;
  issueKey?: string;
  /** The sprint a created issue joined (D57); absent when it stayed in the backlog. */
  sprint?: string;
  dependencyId?: string;
  memoryId?: string;
  communicationId?: string;
  /** What revoking the approval needs, read just before the write (D54). */
  undo?: Undo;
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
  /**
   * One write that revokes an approval (D54): a Jira action through `run`, or a
   * local change, logged with the proposal id. A warning when part of it did not
   * happen (a mirrored wait's Jira link).
   */
  readonly reverse: (
    op: ReverseOp,
    opts: { proposalId: string },
  ) => Effect.Effect<{ warning?: string }, ExecutorError | JiraError | DbError>;
}

export class Executor extends Context.Tag("Executor")<Executor, ExecutorShape>() {}

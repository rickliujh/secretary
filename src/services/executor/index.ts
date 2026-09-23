import { Context, Data, type Effect } from "effect";
import type { DbError } from "@/services/db";
import type { JiraError } from "@/services/jira";
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

export interface ExecutorShape {
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

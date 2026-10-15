import { Context, Data, type Effect } from "effect";
import type { DbError } from "@/services/db";
import type { ExecutorError } from "@/services/executor";
import type { JiraError } from "@/services/jira";
import type { ProposalPayload } from "./schema";

export * from "./schema";

export class ProposalError extends Data.TaggedError("ProposalError")<{
  readonly kind: "not_found" | "decided" | "invalid";
  readonly message: string;
}> {}

export type DecisionResult = {
  status: "executed" | "failed";
  message: string;
  issueKey?: string;
  /** Set when it ran but part of it did not happen, such as a sprint move (D44). */
  warning?: string;
};

export interface ProposalsShape {
  /** Approves (optionally with edits) and executes one proposal. Execution failures are recorded, not thrown. */
  readonly approve: (
    id: string,
    edited?: ProposalPayload,
  ) => Effect.Effect<DecisionResult, ProposalError | DbError>;
  readonly reject: (id: string) => Effect.Effect<void, ProposalError | DbError>;
  /** Approves every pending proposal of an inbox item in order; failures do not block the rest (FR-2.4). */
  readonly approveAll: (
    inboxItemId: string,
  ) => Effect.Effect<DecisionResult[], ProposalError | DbError>;
  /**
   * Track (D44): approves a small-ask bundle in the order given, the create
   * first, with the user's row changes as edits. Stops when the create fails, so
   * nothing that hangs on it runs.
   */
  readonly track: (
    ids: readonly string[],
    edits?: Readonly<Record<string, ProposalPayload>>,
  ) => Effect.Effect<DecisionResult[], ProposalError | DbError>;
  /**
   * Keeps an edit on a pending proposal without approving it, so every way of
   * approving it later (its card, Approve all, Track) uses the edit (D44). An edit
   * equal to the proposal clears it. The correction is recorded at approval.
   */
  readonly saveEdit: (
    id: string,
    edited: ProposalPayload,
  ) => Effect.Effect<void, ProposalError | DbError>;
  /** Marks the inbox item dismissed and rejects its pending proposals without recording corrections. */
  readonly dismiss: (inboxItemId: string) => Effect.Effect<void, DbError>;
}

export class Proposals extends Context.Tag("Proposals")<Proposals, ProposalsShape>() {}

export type ExecutionFailure = ExecutorError | JiraError | DbError;

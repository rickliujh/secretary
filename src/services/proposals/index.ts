import { Context, Data, type Effect } from "effect";
import type { DbError } from "@/services/db";
import type { ExecutorError } from "@/services/executor";
import type { JiraError } from "@/services/jira";
import type { RevokedTicket, RevokePlan } from "./revoke";
import type { ProposalPayload } from "./schema";

export type { RevokedTicket, RevokeEntry, RevokePlan, RevokeStep } from "./revoke";
export * from "./schema";

export class ProposalError extends Data.TaggedError("ProposalError")<{
  readonly kind: "not_found" | "decided" | "invalid" | "busy";
  readonly message: string;
}> {}

export type DecisionResult = {
  status: "executed" | "failed";
  message: string;
  issueKey?: string;
  /** Set when it ran but part of it did not happen, such as a sprint move (D44). */
  warning?: string;
};

/** The outcome of a revoke (D54); a failed step is recorded, not thrown. */
export type RevokeResult = {
  status: "revoked" | "failed";
  message: string;
  /** What was undone, in order, including before a failure. */
  undone: string[];
  /** What was left as it is: changed since (FR-14.3), or a cascaded proposal that cannot be undone. */
  warning?: string;
};

/**
 * Stored on a revoked proposal's result (D54 (4)). From FR-14.6 also: for a
 * create, what became of its ticket; `unchanged` when nothing was changed back
 * (already as it was, or Jira refused), so `message` says why.
 */
export type RevokedRecord = {
  at: string;
  message: string;
  warning?: string;
  ticket?: RevokedTicket;
  unchanged?: true;
};
/** Stored on an executed proposal whose revoke stopped at a failed step; Revoke runs again. */
export type RevokeErrorRecord = { at: string; message: string; undone: string[] };

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
   * An outcome card (Phase 25, D61), generalising Track: runs the steps of the
   * bundle the user kept, in `seq` order, with edits saved on them, and stops
   * when a required step fails. Steps left out are rejected and recorded as
   * corrections (`step_left_out`); leaving out a required step leaves out what
   * hangs on it. A card with no steps is filed. Not a rejection for the quiet list.
   *
   * Also a playbook's bundle inside a thread (Phase 26), whose id is the
   * proposal it expanded. `found` is the user's pick among the tickets the
   * "waiting on someone" search found (null: none of them; left out: code's
   * pre-selection): it sets the link step's blocker, the wait's reference and
   * the comment's "see KEY"; with nothing picked the link step is skipped
   * without a correction.
   */
  readonly approveBundle: (
    bundleId: string,
    keep: readonly string[],
    edits?: Readonly<Record<string, ProposalPayload>>,
    opts?: { found?: string | null },
  ) => Effect.Effect<DecisionResult[], ProposalError | DbError>;
  /**
   * "Done anyway" on an outcome card a failed step keeps open (Phase 25): files
   * it as it is, failed steps staying failed, with no correction recorded.
   */
  readonly fileBundle: (bundleId: string) => Effect.Effect<void, DbError>;
  /**
   * Keeps an edit on a pending proposal without approving it, so every way of
   * approving it later (its card, Approve all, Track) uses the edit (D44). An edit
   * equal to the proposal clears it. The correction is recorded at approval.
   */
  readonly saveEdit: (
    id: string,
    edited: ProposalPayload,
  ) => Effect.Effect<void, ProposalError | DbError>;
  /**
   * What revoking an executed proposal would do (FR-14, D54): for a create, the
   * executed proposals of its thread that act on the new ticket first, newest
   * first; each with its steps, notes, warnings, or why it cannot be undone.
   * Reads Jira fresh; writes nothing.
   */
  readonly revokePlan: (
    id: string,
  ) => Effect.Effect<RevokePlan, ProposalError | JiraError | DbError>;
  /**
   * Plans again and runs the steps through the Executor. `confirmed` is the step
   * text the user saw; when the fresh plan differs, nothing runs. A failed step
   * stops the revoke, leaves the proposal executed with `revokeError`, and
   * Revoke can be pressed again: steps already done are skipped. Fails with
   * `busy` while a revoke of it (or of a cascade that covers it) runs. A revoked
   * create rejects the pending proposals of its thread that act on the ticket.
   */
  readonly revoke: (
    id: string,
    confirmed?: readonly string[],
  ) => Effect.Effect<RevokeResult, ProposalError | JiraError | DbError>;
  /**
   * Marks the inbox item dismissed and rejects its pending proposals without
   * recording corrections. On an outcome card it records `outcome_dismissed`,
   * which the quiet list counts (D61).
   */
  readonly dismiss: (inboxItemId: string) => Effect.Effect<void, DbError>;
}

export class Proposals extends Context.Tag("Proposals")<Proposals, ProposalsShape>() {}

export type ExecutionFailure = ExecutorError | JiraError | DbError;

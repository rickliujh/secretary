import { Context, Data, type Effect } from "effect";
import type { DbError } from "@/services/db";
import type { KindAgreement } from "@/services/eval/score";
import type { LlmError, TestTarget } from "@/services/llm";

export class LearningError extends Data.TaggedError("LearningError")<{
  readonly kind: "not_enough";
  readonly message: string;
}> {}

export type ConsolidateResult = {
  /** The thread holding the suggested rules as proposals, or null when there were none. */
  inboxItemId: string | null;
  rules: number;
  corrections: number;
};

export type ReplayResult = {
  items: number;
  /** Items the model could not answer validly. */
  failed: number;
  byKind: KindAgreement[];
  model: string;
};

export interface LearningShape {
  /** Suggests rules from correction examples as `remember` proposals (FR-7.4, D26). */
  readonly consolidate: Effect.Effect<ConsolidateResult, LearningError | LlmError | DbError>;
  /**
   * Re-runs decided inbox items from their stored snapshots on `target` and
   * compares with what the user approved (FR-9.4).
   */
  readonly replay: (opts: {
    target: TestTarget;
    limit?: number;
    onProgress?: (done: number, total: number) => void;
  }) => Effect.Effect<ReplayResult, LearningError | LlmError | DbError>;
}

export class Learning extends Context.Tag("Learning")<Learning, LearningShape>() {}

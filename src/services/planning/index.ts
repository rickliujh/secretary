import { Context, Data, type Effect } from "effect";
import type { PlanOutput } from "@/prompts/plan";
import type { DbError } from "@/services/db";
import type { LlmError } from "@/services/llm";
import type { Candidate, Velocity } from "./logic";

export * from "./logic";

export class PlanningError extends Data.TaggedError("PlanningError")<{
  /** no_user: Jira not synced yet; no_sprint: no next sprint in Jira; no_candidates: nothing to plan. */
  readonly kind: "no_user" | "no_sprint" | "no_candidates";
  readonly message: string;
}> {}

export type SprintRef = { id: number; name: string; start: string | null; end: string | null };

/** Everything the Planning page shows before and around a plan (design.md D30). */
export type PlanPrep = {
  /** The active sprint holding the user's work, or null. */
  ending: SprintRef | null;
  /** The board's next future sprint in Jira, or null when it is not created yet. */
  next: SprintRef | null;
  /** The user's work in the ending sprint, in story points. */
  endingSummary: { committed: number; done: number; open: number; unestimated: number } | null;
  velocity: Velocity;
  /** Default capacity: the velocity average (null without history). */
  capacity: number | null;
  candidates: Candidate[];
};

export type PlanDraft = PlanOutput & {
  /** Story points of the picks, and picks without an estimate. */
  points: number;
  unestimated: string[];
};

export type PlanToPropose = {
  goal: string;
  picks: string[];
  deferred: { key: string; reason: string }[];
  risks: string[];
};

export interface PlanningShape {
  /** Sprint pair, velocity and candidates for today. */
  readonly prepare: (today?: string) => Effect.Effect<PlanPrep, PlanningError | DbError>;
  /** Asks the model for a plan within `capacity`; `instructions` are the user's notes. */
  readonly draft: (opts: {
    capacity: number | null;
    instructions: string[];
    today?: string;
  }) => Effect.Effect<{ prep: PlanPrep; plan: PlanDraft }, PlanningError | LlmError | DbError>;
  /**
   * Turns the reviewed plan into `move_to_sprint` proposals in a new Inbox thread
   * (one per pick not already in the next sprint). The user approves them there.
   */
  readonly propose: (
    plan: PlanToPropose,
  ) => Effect.Effect<
    { inboxItemId: string; proposals: number; alreadyThere: string[] },
    PlanningError | DbError
  >;
}

export class Planning extends Context.Tag("Planning")<Planning, PlanningShape>() {}

import { Context, Data, type Effect } from "effect";
import type { DbError } from "@/services/db";
import type { LlmError } from "@/services/llm";

export const SOURCES = ["teams", "email", "meeting", "typed", "other"] as const;
export type Source = (typeof SOURCES)[number];

export class IntakeError extends Data.TaggedError("IntakeError")<{
  readonly kind: "empty" | "not_found";
  readonly message: string;
}> {}

export type TriageInput = {
  text: string;
  source: Source;
  senderPersonId: string | null;
  /** Answer to an earlier clarification question; the question proposal is closed. */
  clarifies?: { proposalId: string; answer: string };
  /** Local date as YYYY-MM-DD; defaults to today. */
  today?: string;
  onProgress?: (message: string) => void;
};

export type TriageResult = {
  inboxItemId: string;
  items: number;
  proposals: number;
  questions: number;
};

export interface IntakeShape {
  /** Messy input -> persisted inbox item, items and pending proposals (FR-2.1, FR-2.2). */
  readonly triage: (
    input: TriageInput,
  ) => Effect.Effect<TriageResult, IntakeError | LlmError | DbError>;
  /** Runs triage again for a stored inbox item, replacing its undecided proposals. */
  readonly retriage: (
    inboxItemId: string,
  ) => Effect.Effect<TriageResult, IntakeError | LlmError | DbError>;
}

export class Intake extends Context.Tag("Intake")<Intake, IntakeShape>() {}

export const localDate = (d = new Date()) => d.toLocaleDateString("en-CA");

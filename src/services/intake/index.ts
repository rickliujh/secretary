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
  /** The input: pasted text, or what the user typed when nothing was pasted. */
  text: string;
  /** The user's typed words sent with pasted input: a trusted instruction (D22). */
  instruction?: string | null;
  source: Source;
  senderPersonId: string | null;
  /** Local date as YYYY-MM-DD; defaults to today. */
  today?: string;
  onProgress?: (message: string) => void;
};

export type ReplyInput = {
  inboxItemId: string;
  /** Newly pasted text; it becomes new items of the thread. */
  text?: string;
  /** Typed words: they instruct the new text, or revise existing items when nothing was pasted. */
  instruction?: string | null;
  /** The pending question this reply answers. */
  answers?: string | null;
  /** Source of the pasted text; defaults to the thread's. */
  source?: Source;
  today?: string;
  onProgress?: (message: string) => void;
};

export type TriageResult = {
  inboxItemId: string;
  items: number;
  proposals: number;
  questions: number;
};

type IntakeFailure = IntakeError | LlmError | DbError;

export interface IntakeShape {
  /** Messy input -> a new thread with items and pending proposals (FR-2.1, FR-2.2). */
  readonly triage: (input: TriageInput) => Effect.Effect<TriageResult, IntakeFailure>;
  /** A follow-up in a thread: new input, an instruction, or an answer (design.md D22). */
  readonly reply: (input: ReplyInput) => Effect.Effect<TriageResult, IntakeFailure>;
  /**
   * Runs the thread again: an unanswered last message is retried; otherwise every
   * item is classified again with all instructions, replacing undecided proposals.
   */
  readonly retriage: (inboxItemId: string) => Effect.Effect<TriageResult, IntakeFailure>;
}

export class Intake extends Context.Tag("Intake")<Intake, IntakeShape>() {}

export { localDate } from "@/lib/dates";

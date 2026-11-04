import { Context, Data, type Effect } from "effect";
import type { DbError } from "@/services/db";
import type { LlmError, SkipRequest, Tier } from "@/services/llm";
import type { RunEvent } from "./runs";
import type { MessagePart } from "./thread";

export type { RunEvent } from "./runs";

/** `note`: a block of the daily note the secretary read (D65): the user's own words. */
export const SOURCES = ["teams", "email", "meeting", "typed", "other", "note"] as const;
export type Source = (typeof SOURCES)[number];

export class IntakeError extends Data.TaggedError("IntakeError")<{
  readonly kind: "empty" | "not_found" | "read_only" | "decided";
  readonly message: string;
}> {}

/** How a turn reports and is steered while it runs (D68). */
export type TurnControl = {
  /** Structured progress: steps, attempts, items done (D68). */
  onEvent?: (e: RunEvent) => void;
  /** Older callers: one line per step, derived from the steps `onEvent` gets. */
  onProgress?: (message: string) => void;
  /** Resolves when the user cuts the current model call short (D68). */
  skip?: (signal: AbortSignal) => Promise<SkipRequest>;
  /** A one-off tier for the turn's classify calls (the fast-tier buttons, D68). */
  tier?: Tier;
  /** Resume: the message whose turn to read on; the oldest unread turn otherwise. */
  messageId?: string | null;
};

export type TriageInput = TurnControl & {
  /** The input: pasted text, or what the user typed when nothing was pasted. */
  text?: string;
  /** The user's typed words sent with pasted input: a trusted instruction (D22). */
  instruction?: string | null;
  /**
   * The message as written in the message box, in order (D56). When given, the
   * input and instruction are worked out from it and `text` and `instruction`
   * are ignored; with no paste that is input, the message is typed input.
   */
  parts?: readonly MessagePart[];
  /** Where pasted input is from. */
  source: Source;
  senderPersonId: string | null;
  /**
   * "chat" when the chat wrote the text for the user (propose_actions): it is not
   * their own words, so numbers in it need a points cue (D55).
   */
  author?: "chat";
  /**
   * With `source: "note"` (D65): the day of the daily note the block is from.
   * The note's own lines are the user's words, like typed input; lines it
   * quotes with `>` come as pasted parts and stay untrusted.
   */
  noteDate?: string;
  /** Local date as YYYY-MM-DD; defaults to today. */
  today?: string;
};

/** True for input that is the user's own words: typed, or written in their daily note (D65). */
export const ownWordsSource = (source: string) => source === "typed" || source === "note";

export type ReplyInput = TurnControl & {
  inboxItemId: string;
  /** Newly pasted text; it becomes new items of the thread. */
  text?: string;
  /** Typed words: they instruct the new text, or revise existing items when nothing was pasted. */
  instruction?: string | null;
  /** The message as written in the message box (D56); replaces `text` and `instruction`. */
  parts?: readonly MessagePart[];
  /** The pending question this reply answers. */
  answers?: string | null;
  /** Source of the pasted text; defaults to the thread's. */
  source?: Source;
  /**
   * The message is new input to the thread, as a first message is (D66): its
   * typed parts are input, not an instruction, so a block of the daily note
   * joins its thread as new items. Needs `parts`; without it a reply is as before.
   */
  asInput?: boolean;
  /** With `asInput` from the daily note: the day of the note the block is from (D66). */
  noteDate?: string;
  today?: string;
};

export type TriageResult = {
  inboxItemId: string;
  items: number;
  proposals: number;
  questions: number;
};

/** What `withdraw` removed (D68 Edit): the message, and the thread when it held nothing else. */
export type Withdrawn = { inboxItemId: string; thread: boolean };

type IntakeFailure = IntakeError | LlmError | DbError;

export interface IntakeShape {
  /** Messy input -> a new thread with items and pending proposals (FR-2.1, FR-2.2). */
  readonly triage: (input: TriageInput) => Effect.Effect<TriageResult, IntakeFailure>;
  /** A follow-up in a thread: new input, an instruction, or an answer (design.md D22). */
  readonly reply: (input: ReplyInput) => Effect.Effect<TriageResult, IntakeFailure>;
  /**
   * Runs the thread again: a turn that stopped or failed part way resumes its
   * undecided items (D68); an unanswered last message is retried; otherwise every
   * item is classified again with all instructions, replacing undecided proposals.
   */
  readonly retriage: (
    inboxItemId: string,
    control?: TurnControl,
  ) => Effect.Effect<TriageResult, IntakeFailure>;
  /**
   * Classifies only the items a stopped or failed turn left undecided (D68),
   * continuing that turn: their cards join the same answer.
   */
  readonly resume: (
    inboxItemId: string,
    control?: TurnControl,
  ) => Effect.Effect<TriageResult, IntakeFailure>;
  /**
   * Takes a user message back (D68 Edit): the message and what its turn wrote,
   * and the thread when the message was all it held. Refused once a card of its
   * turn was approved or rejected.
   */
  readonly withdraw: (messageId: string) => Effect.Effect<Withdrawn, IntakeFailure>;
  /** Turns in flight when the app quit are recorded as stopped (D68), at the next start. */
  readonly recoverRuns: Effect.Effect<number, DbError>;
}

export class Intake extends Context.Tag("Intake")<Intake, IntakeShape>() {}

export { localDate } from "@/lib/dates";

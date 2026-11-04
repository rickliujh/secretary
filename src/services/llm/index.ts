import type { LanguageModel, ModelMessage, PrepareStepFunction, ToolSet, UIMessageChunk } from "ai";
import { Context, type Effect } from "effect";
import type { z } from "zod";
import type { LlmError, LlmErrorKind } from "./errors";
import type { ModelRequest } from "./providers";
import type { TaskRoute } from "./routing";
import type { InternalTask, TaskType, Tier } from "./tasks";

export * from "./errors";
export * from "./tasks";

export type Usage = { inputTokens: number | undefined; outputTokens: number | undefined };

export type CallInfo = {
  tier: Tier;
  providerId: string;
  model: string;
  escalated: boolean;
  repaired: boolean;
  usage: Usage;
};

/**
 * Retries in the call runner (D68): a call that times out or fails with a 5xx,
 * 429 or network error is tried again on the same tier, up to this many
 * attempts in all, with these pauses between them.
 */
export const RETRY_ATTEMPTS = 3;
export const RETRY_PAUSES_MS: readonly number[] = [2_000, 5_000];
/** The error kinds a retry can cure; schema, auth, refusal and config failures are not retried. */
export const RETRYABLE_KINDS: readonly LlmErrorKind[] = ["timeout", "network", "rate_limit"];

/** One provider call attempt about to start (D68), for progress. */
export type AttemptEvent = {
  task: TaskType | InternalTask;
  /** 1-based; counts every attempt, including the ones the user cut short. */
  number: number;
  /** Failed attempts so far that count against `of` (the user's "try again now" does not). */
  failures: number;
  of: number;
  /** Why it is tried again: null for the first attempt, "user" when the user asked. */
  reason: LlmErrorKind | "user" | null;
  /** Milliseconds of pause before it starts. */
  pauseMs: number;
  tier: Tier | null;
  providerId: string;
  model: string;
  repair: boolean;
  escalated: boolean;
  /** Epoch ms when the attempt was scheduled; it starts `pauseMs` later. */
  at: number;
};

/** The user cut the call short: try again now, on this tier when given (D68). */
export type SkipRequest = { tier?: Tier };

export type CallHooks = {
  onAttempt?: (e: AttemptEvent) => void;
  /**
   * Called for each attempt and each pause; resolves when the user asks to stop
   * waiting for it ("Try again now", "Use the fast tier"). Aborted when the
   * attempt ends on its own.
   */
  skip?: (signal: AbortSignal) => Promise<SkipRequest>;
};

/** Per-call options of `object` and `text`. */
export type CallOptions = {
  /**
   * A one-off tier instead of the task's routing (D68: the fast-tier buttons);
   * escalation still follows the routing, from that tier.
   */
  tier?: Tier;
  hooks?: CallHooks;
};

export type ObjectRequest<T> = CallOptions & {
  schema: z.ZodType<T>;
  system?: string;
  prompt: string;
  /** Business-rule checks in code (candidate membership etc). Return error strings. */
  validate?: (value: T) => readonly string[];
  /** Confidence reported by the output, 0..1, compared with the task threshold. */
  confidence?: (value: T) => number;
  /**
   * Run exactly this tier or model, with repair but no escalation (evaluation
   * replay, FR-9.4). Routing still applies when absent.
   */
  target?: TestTarget;
};

export type ObjectResult<T> = CallInfo & {
  value: T;
  /** True when the final value is still below the task's confidence threshold. */
  lowConfidence: boolean;
};

export type TextRequest = CallOptions & { system?: string; prompt: string };

/** A streamed tool loop (chat, design.md D25). */
export type StreamRequest = {
  system: string;
  messages: ModelMessage[];
  tools: ToolSet;
  /** Upper bound on model steps (tool calls plus the answer). */
  maxSteps: number;
  /** A tier to use instead of the task's routing. */
  tier?: Tier;
  abortSignal?: AbortSignal;
  /** Changes the messages before each step (the chat adds fetched images, D33). */
  prepareStep?: PrepareStepFunction<ToolSet>;
};
export type TextResult = CallInfo & { text: string };

export type TestTarget = { tier: Tier } | { providerId: string; model: string };
export type TestResult = {
  text: string;
  model: string;
  providerId: string;
  durationMs: number;
  usage: Usage;
};

export interface LlmShape {
  /** Schema-bound call with validate -> repair -> escalate (design.md 7.0 rule 4). */
  readonly object: <T>(
    task: TaskType,
    req: ObjectRequest<T>,
  ) => Effect.Effect<ObjectResult<T>, LlmError>;
  readonly text: (task: TaskType, req: TextRequest) => Effect.Effect<TextResult, LlmError>;
  /** Streams a tool loop as UI message chunks; errors arrive in the stream. */
  readonly stream: (
    task: TaskType,
    req: StreamRequest,
  ) => Effect.Effect<ReadableStream<UIMessageChunk>, LlmError>;
  /** Connection test. Recorded in `llm_calls` as task `test_connection`. */
  readonly test: (target: TestTarget) => Effect.Effect<TestResult, LlmError>;
  /** Current routing for a task, for display in settings. */
  readonly route: (task: TaskType) => Effect.Effect<TaskRoute, LlmError>;
}

export class Llm extends Context.Tag("Llm")<Llm, LlmShape>() {}

/** Builds a language model for a provider; swapped for mocks in tests. */
export class ModelFactory extends Context.Tag("ModelFactory")<
  ModelFactory,
  { readonly make: (req: Omit<ModelRequest, "fetch">) => LanguageModel }
>() {}

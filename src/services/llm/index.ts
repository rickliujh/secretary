import type { LanguageModel } from "ai";
import { Context, type Effect } from "effect";
import type { z } from "zod";
import type { LlmError } from "./errors";
import type { ModelRequest } from "./providers";
import type { TaskRoute } from "./routing";
import type { TaskType, Tier } from "./tasks";

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

export type ObjectRequest<T> = {
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

export type TextRequest = { system?: string; prompt: string };
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

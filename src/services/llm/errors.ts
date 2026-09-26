import { APICallError, NoObjectGeneratedError, RetryError } from "ai";
import { Data } from "effect";
import { redact } from "@/lib/redact";

export type LlmErrorKind =
  | "config"
  | "auth"
  | "network"
  | "rate_limit"
  | "refusal"
  | "schema"
  | "timeout"
  | "cancelled"
  | "provider";

export class LlmError extends Data.TaggedError("LlmError")<{
  readonly kind: LlmErrorKind;
  readonly message: string;
  /** Validation errors for `schema` failures. */
  readonly issues?: readonly string[];
}> {}

const isAbort = (e: unknown) =>
  e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");

/** Maps an AI SDK or transport error to an `LlmError`. Messages are redacted. */
export function toLlmError(error: unknown): LlmError {
  const root = RetryError.isInstance(error) ? error.lastError : error;
  if (isAbort(root))
    return new LlmError({ kind: "cancelled", message: "The request was cancelled" });
  if (APICallError.isInstance(root)) {
    const status = root.statusCode;
    const detail = redact(root.responseBody?.slice(0, 2000) ?? root.message);
    if (status === 401 || status === 403)
      return new LlmError({
        kind: "auth",
        message: `Provider rejected the credentials (${status}): ${detail}`,
      });
    if (status === 429)
      return new LlmError({ kind: "rate_limit", message: `Rate limited: ${detail}` });
    if (status === undefined || status >= 500)
      return new LlmError({
        kind: "network",
        message: `Provider unavailable${status ? ` (${status})` : ""}: ${detail}`,
      });
    return new LlmError({ kind: "provider", message: `Provider error ${status}: ${detail}` });
  }
  if (NoObjectGeneratedError.isInstance(root)) {
    return new LlmError({
      kind: "schema",
      message: "The model did not return valid structured output",
      issues: [redact(root.cause instanceof Error ? root.cause.message : root.message)],
    });
  }
  const message = root instanceof Error ? root.message : String(root);
  if (/fetch|network|ECONN|ENOTFOUND|timed? ?out/i.test(message))
    return new LlmError({ kind: "network", message: redact(message) });
  return new LlmError({ kind: "provider", message: redact(message) });
}

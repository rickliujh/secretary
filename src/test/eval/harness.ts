/**
 * Pure helpers of the live eval harness: the run's knobs, OpenRouter provider
 * pinning, per-case model call counts and the provider fail-fast rule.
 */
import type { LlmErrorKind } from "@/services/llm/errors";

/** Cases run at once unless SECRETARY_EVAL_CONCURRENCY says otherwise; 1 is sequential. */
export const DEFAULT_CONCURRENCY = 6;

export function parseConcurrency(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_CONCURRENCY;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1)
    throw new Error(
      `SECRETARY_EVAL_CONCURRENCY must be a whole number of 1 or more, got "${value}"`,
    );
  return n;
}

/**
 * The OpenRouter providers SECRETARY_EVAL_PROVIDER names, in order: a
 * comma-separated list such as `deepinfra/fp4,streamlake/fp8,novita/fp8`, or one
 * slug. Null when unset or empty.
 */
export function parseProviders(value: string | undefined): string[] | null {
  const slugs = [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  return slugs.length ? slugs : null;
}

/**
 * Routes an OpenRouter chat-completions JSON body to the listed upstream
 * providers: adds `provider: { order, only, allow_fallbacks: true }` with the
 * list in both. `order` sends the request to the first provider and on to the
 * next when one fails; `only` keeps every attempt inside the list. One slug pins
 * that provider. OpenRouter skips listed providers that lack a parameter the
 * request uses, so the eval also walks the list on 429s (`afterRateLimit`). Eval only; the app has no such setting. Anything that is not a JSON
 * object is returned unchanged.
 */
export function pinProvider(body: string, slugs: readonly string[]): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return body;
  return JSON.stringify({
    ...parsed,
    provider: { order: [...slugs], only: [...slugs], allow_fallbacks: true },
  });
}

/**
 * The providers the eval asks next after a 429 from `asked` (a tail of the
 * SECRETARY_EVAL_PROVIDER list): the rest of it, at once, or null when the last
 * one turned the request away, and the eval waits (`backoffMs`) and starts again
 * from the top. OpenRouter does not move down the list by itself here: a
 * schema-bound request (`response_format` json_schema) goes only to the listed
 * providers that support structured outputs, so with DeepInfra first a busy
 * DeepInfra answers 429 although StreamLake and Novita are free.
 */
export function afterRateLimit(asked: readonly string[]): string[] | null {
  return asked.length > 1 ? asked.slice(1) : null;
}

/**
 * How often the eval's model fetch waits out a 429 before handing it to the app.
 * A pinned OpenRouter provider answers from a shared pool that turns requests
 * away for seconds at a time ("temporarily rate-limited upstream"); a 429 costs
 * nothing, and the eval measures the model, not that pool. With a provider list
 * the eval first tries the rest of the list without waiting (`afterRateLimit`),
 * so it waits only when every listed provider turned the request away. The app's
 * own single retry is unchanged, and its timeout still bounds the whole call.
 */
export const RATE_LIMIT_RETRIES = 6;

/** Wait before retry `attempt` (0-based): doubling from 2 s, at most 20 s, with jitter. */
export function backoffMs(attempt: number, random = Math.random()): number {
  return Math.round(Math.min(2000 * 2 ** attempt, 20_000) * (0.5 + random));
}

export type CallRow = {
  ok: boolean;
  repair: boolean;
  escalated: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
};

export type CallStats = {
  calls: number;
  repairs: number;
  escalations: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
};

export const noCalls: CallStats = {
  calls: 0,
  repairs: 0,
  escalations: 0,
  failed: 0,
  inputTokens: 0,
  outputTokens: 0,
};

export function callStats(rows: readonly CallRow[]): CallStats {
  return rows.reduce(
    (s, r) => ({
      calls: s.calls + 1,
      repairs: s.repairs + (r.repair ? 1 : 0),
      escalations: s.escalations + (r.escalated ? 1 : 0),
      failed: s.failed + (r.ok ? 0 : 1),
      inputTokens: s.inputTokens + (r.inputTokens ?? 0),
      outputTokens: s.outputTokens + (r.outputTokens ?? 0),
    }),
    noCalls,
  );
}

export function addStats(a: CallStats, b: CallStats): CallStats {
  return {
    calls: a.calls + b.calls,
    repairs: a.repairs + b.repairs,
    escalations: a.escalations + b.escalations,
    failed: a.failed + b.failed,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

/** "4 calls (1 repair, 1 failed)". SDK-level retries inside one call are not recorded. */
export function describeStats(s: CallStats): string {
  const extra = [
    s.repairs && `${s.repairs} repair${s.repairs > 1 ? "s" : ""}`,
    s.escalations && `${s.escalations} escalated`,
    s.failed && `${s.failed} failed`,
  ].filter(Boolean);
  return `${s.calls} call${s.calls === 1 ? "" : "s"}${extra.length ? ` (${extra.join(", ")})` : ""}`;
}

/**
 * How many cases must finish, all with a provider error of the same kind, before
 * the run stops. Three in a row with nothing passing is the provider, not the
 * prompt: a timed-out case burns four minutes, so grinding through 27 of them
 * costs most of an hour and still says nothing about the model.
 */
export const FAIL_FAST_AFTER = 3;

/** Provider error kinds that repeat for every case when they happen at all. */
const REPEATING: readonly LlmErrorKind[] = ["timeout", "rate_limit", "network", "provider"];

/**
 * The kind of provider error that should stop the run, or null to go on.
 * `finished` is every case's provider error kind (null when the case got an
 * answer), in the order the cases finished. An auth error stops at once.
 */
export function stopReason(
  finished: readonly (LlmErrorKind | null)[],
  total: number,
): LlmErrorKind | null {
  const last = finished[finished.length - 1];
  if (last === "auth") return "auth";
  const needed = Math.min(FAIL_FAST_AFTER, total);
  if (finished.length !== needed) return null;
  const first = finished[0];
  if (!first || !REPEATING.includes(first)) return null;
  return finished.every((k) => k === first) ? first : null;
}

const HINTS: Partial<Record<LlmErrorKind, string>> = {
  auth: "The provider rejected the API key (401/403). Check SECRETARY_EVAL_API_KEY and the key's spending limit.",
  timeout:
    "Every case so far timed out waiting for the model. The provider is too slow for the app's timeouts: use a faster routing (on OpenRouter, pin a fast provider with SECRETARY_EVAL_PROVIDER or add the :nitro suffix to the model), or lower the reasoning effort with SECRETARY_EVAL_EFFORT=low.",
  rate_limit:
    "Every case so far was rate limited. Lower SECRETARY_EVAL_CONCURRENCY, wait, or check the key's limits.",
  network:
    "Every case so far failed to reach the provider or got a server error. Check SECRETARY_EVAL_BASE_URL and the provider's status, or try another routing.",
  provider:
    "Every case so far got the same error from the provider. Check the model name, SECRETARY_EVAL_PROVIDER and SECRETARY_EVAL_EFFORT (some servers reject reasoning_effort).",
};

export function stopMessage(kind: LlmErrorKind, finished: number, total: number): string {
  return `Stopped the intake eval after ${finished} of ${total} cases: provider error "${kind}". ${HINTS[kind] ?? ""}`.trim();
}

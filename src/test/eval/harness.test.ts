import { describe, expect, test } from "bun:test";
import {
  backoffMs,
  callStats,
  DEFAULT_CONCURRENCY,
  describeStats,
  FAIL_FAST_AFTER,
  parseConcurrency,
  pinProvider,
  stopReason,
} from "./harness";

describe("live eval harness", () => {
  test("concurrency defaults to 6 and rejects nonsense", () => {
    expect(parseConcurrency(undefined)).toBe(DEFAULT_CONCURRENCY);
    expect(parseConcurrency("")).toBe(DEFAULT_CONCURRENCY);
    expect(parseConcurrency("1")).toBe(1);
    expect(parseConcurrency("12")).toBe(12);
    expect(() => parseConcurrency("0")).toThrow();
    expect(() => parseConcurrency("two")).toThrow();
    expect(() => parseConcurrency("1.5")).toThrow();
  });

  test("pins the OpenRouter provider in a JSON body and leaves the rest", () => {
    const body = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(JSON.parse(pinProvider(body, "deepinfra/fp4"))).toEqual({
      model: "m",
      messages: [{ role: "user", content: "hi" }],
      provider: { only: ["deepinfra/fp4"], allow_fallbacks: false },
    });
    expect(pinProvider("not json", "x")).toBe("not json");
    expect(pinProvider("[1]", "x")).toBe("[1]");
  });

  test("counts calls, repairs, escalations, failures and tokens", () => {
    const s = callStats([
      { ok: true, repair: false, escalated: false, inputTokens: 100, outputTokens: 10 },
      { ok: true, repair: true, escalated: false, inputTokens: 120, outputTokens: 12 },
      { ok: false, repair: false, escalated: true, inputTokens: null, outputTokens: null },
    ]);
    expect(s).toEqual({
      calls: 3,
      repairs: 1,
      escalations: 1,
      failed: 1,
      inputTokens: 220,
      outputTokens: 22,
    });
    expect(describeStats(s)).toBe("3 calls (1 repair, 1 escalated, 1 failed)");
    expect(describeStats(callStats([]))).toBe("0 calls");
  });

  test("429 backoff doubles from 2 s up to 20 s, with jitter around it", () => {
    expect([0, 1, 2, 3, 4, 5].map((a) => backoffMs(a, 0.5))).toEqual([
      2000, 4000, 8000, 16_000, 20_000, 20_000,
    ]);
    expect(backoffMs(0, 0)).toBe(1000);
    expect(backoffMs(9, 0.999)).toBeLessThan(30_000);
  });

  test("an auth error stops at once", () => {
    expect(stopReason(["auth"], 27)).toBe("auth");
    expect(stopReason([null, null, null, null, "auth"], 27)).toBe("auth");
  });

  test("the first cases all failing the same way stop the run", () => {
    const same = Array.from({ length: FAIL_FAST_AFTER }, () => "timeout" as const);
    expect(stopReason(same.slice(0, -1), 27)).toBeNull();
    expect(stopReason(same, 27)).toBe("timeout");
    expect(stopReason([...same.slice(0, -1), null], 27)).toBeNull();
    expect(stopReason([...same.slice(0, -1), "rate_limit"], 27)).toBeNull();
    // Only the first cases decide; a later streak is left to the report.
    expect(stopReason([null, ...same], 27)).toBeNull();
    // Schema failures are the model's answers, not the provider.
    expect(stopReason(["schema", "schema", "schema"], 27)).toBeNull();
    // A single selected case stops on its own provider error.
    expect(stopReason(["timeout"], 1)).toBe("timeout");
  });
});

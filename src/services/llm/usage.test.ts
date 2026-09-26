import { describe, expect, test } from "bun:test";
import { summarizeUsage } from "./usage";

describe("summarizeUsage", () => {
  test("totals by tier and overall", () => {
    const s = summarizeUsage([
      { tier: "fast", inputTokens: 10, outputTokens: 2, ok: true },
      { tier: "fast", inputTokens: 5, outputTokens: null, ok: false },
      { tier: "strong", inputTokens: 100, outputTokens: 50, ok: true },
      { tier: null, inputTokens: 3, outputTokens: 1, ok: true },
    ]);
    expect(s.calls).toBe(4);
    expect(s.failed).toBe(1);
    expect(s.inputTokens).toBe(118);
    expect(s.outputTokens).toBe(53);
    expect(s.byTier.fast).toEqual({ calls: 2, inputTokens: 15, outputTokens: 2 });
    expect(s.byTier.untiered.calls).toBe(1);
    expect(s.byTier.standard.calls).toBe(0);
  });
});

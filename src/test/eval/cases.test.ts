import { describe, expect, test } from "bun:test";
import { fixtureIssues } from "@/test/seed";
import { EVAL_CASES } from "./cases";

describe("eval cases", () => {
  test("every expected issue target exists in the fixtures", () => {
    const keys = new Set(fixtureIssues.map((i) => i.key));
    for (const c of EVAL_CASES) {
      for (const r of c.expect.required) {
        if (r.target?.match(/^[A-Z]+-\d+$/)) expect(keys.has(r.target)).toBe(true);
      }
    }
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(5);
  });

  test("small-ask cases run with a home and check what code decides (D44)", () => {
    const small = EVAL_CASES.filter((c) => c.home);
    expect(small.length).toBeGreaterThanOrEqual(4);
    // Every small-ask case says whether the create is a small ask.
    for (const c of small)
      expect(
        c.expect.required.some((r) => r.kind === "create_issue" && "smallAsk" in (r.fields ?? {})),
      ).toBe(true);
    expect(small.some((c) => c.requester && c.sender === c.requester)).toBe(true);
  });
});

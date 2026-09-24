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
});

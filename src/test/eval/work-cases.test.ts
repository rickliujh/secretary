import { describe, expect, test } from "bun:test";
import { toWorkState, validateWorkState } from "@/prompts/work-state";
import { scoreWorkCase, WORK_EVAL_CASES } from "./work-cases";

describe("work eval cases", () => {
  test("names are unique", () => {
    const names = WORK_EVAL_CASES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  for (const c of WORK_EVAL_CASES)
    test(`the ideal answer passes code's checks and the scorer: ${c.name}`, () => {
      expect(validateWorkState(c.ideal, c.input)).toEqual([]);
      expect(scoreWorkCase(c, toWorkState(c.ideal, c.input))).toEqual([]);
    });

  test("the scorer fails what the case rules out", () => {
    const [moved, promise] = WORK_EVAL_CASES;
    if (!moved || !promise) throw new Error("cases");
    expect(
      scoreWorkCase(
        moved,
        toWorkState({ ...moved.ideal, nextExpectedOn: "2026-10-15" }, moved.input),
      ),
    ).toHaveLength(1);
    expect(
      scoreWorkCase(promise, toWorkState({ ...promise.ideal, commitments: [] }, promise.input)),
    ).toHaveLength(1);
    expect(scoreWorkCase(moved, null)).toHaveLength(1);
  });
});

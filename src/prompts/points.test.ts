import { describe, expect, test } from "bun:test";
import {
  createPoints,
  keptPoints,
  type PointsContext,
  parsePoints,
  pointSources,
  pointsKey,
  pointsProblems,
  statedNumbers,
} from "./points";

describe("parsePoints", () => {
  test("numbers as text, with or without a unit", () => {
    expect(parsePoints("3")).toBe(3);
    expect(parsePoints(" 0.5 ")).toBe(0.5);
    expect(parsePoints("1,5")).toBe(1.5);
    expect(parsePoints("5 points")).toBe(5);
    expect(parsePoints("8 SP")).toBe(8);
    expect(parsePoints(13)).toBe(13);
  });

  test("empty is none; anything else is invalid", () => {
    expect(parsePoints("")).toBeNull();
    expect(parsePoints(null)).toBeNull();
    expect(parsePoints(undefined)).toBeNull();
    expect(parsePoints("three")).toBe("invalid");
    expect(parsePoints("3-5")).toBe("invalid");
    expect(parsePoints("-2")).toBe("invalid");
  });
});

describe("statedNumbers: numbers given as points", () => {
  const stated = (...texts: string[]) => [...statedNumbers(texts)].sort((a, b) => a - b);

  test("a number next to a points cue", () => {
    expect(stated("It's a 3-pointer.")).toEqual([3]);
    expect(stated("a three-pointer at most")).toEqual([3]);
    expect(stated("a three point story")).toEqual([3]);
    expect(stated("5 points", "8 SP", "0.5 pts")).toEqual([0.5, 5, 8]);
    expect(stated("PAY-12 is more like a 5")).toEqual([5]);
    expect(stated("feels like 8 to me")).toEqual([8]);
    expect(stated("estimate of 13", "estimated at 2", "set the points to 1", "SP: 21")).toEqual([
      1, 2, 13, 21,
    ]);
  });

  test("numbers without a cue do not count", () => {
    expect(stated("send me two reports")).toEqual([]);
    expect(stated("the one about refunds, due in 3 days")).toEqual([]);
    expect(stated("Send the Q3 numbers for v2")).toEqual([]);
    expect(stated("like one of those")).toEqual([]);
  });

  test("issue keys in any case, ISO dates and times do not count", () => {
    expect(stated("pay-12 points at PAY-7, due 2026-10-09 at 14:30 points")).toEqual([]);
  });

  test("a list before the cue counts every number; a comma between digits separates", () => {
    expect(stated("3,5 or 8 points")).toEqual([3, 5, 8]);
    expect(stated("somewhere between 5-8 points")).toEqual([5, 8]);
  });

  test("the user's instructions count too", () => {
    expect(statedNumbers(["Create a ticket for it", "make it 0.5 points"]).has(0.5)).toBe(true);
  });
});

describe("keptPoints: per pending proposal, never an estimate", () => {
  test("a create by ref, an update by target; estimates do not count; clears are kept", () => {
    const kept = keptPoints([
      { kind: "create_issue", ref: "$new:1", storyPoints: "5", pointsSource: "estimated" },
      { kind: "create_issue", ref: "$new:2", storyPoints: "13", pointsSource: "stated" },
      { kind: "create_issue", ref: "$new:3", pointsCleared: true },
      { kind: "update_issue", target: "PAY-4", storyPoints: "8", pointsSource: "stated" },
      { kind: "add_comment", target: "PAY-4" },
    ]);
    expect(kept.get("create:$new:1")).toEqual({ points: null, cleared: false });
    expect(kept.get("create:$new:2")).toEqual({ points: 13, cleared: false });
    expect(kept.get("create:$new:3")).toEqual({ points: null, cleared: true });
    expect(kept.get("update:PAY-4")).toEqual({ points: 8, cleared: false });
    expect(kept.size).toBe(4);
    expect(pointsKey({ kind: "update_issue", target: "PAY-2" })).toBe("update:PAY-2");
    expect(keptPoints(undefined).size).toBe(0);
  });
});

describe("pointsProblems (D55)", () => {
  const base: PointsContext = {
    kind: "create_issue",
    storyPoints: null,
    pointsSource: null,
    epic: false,
    scale: [1, 2, 3, 5, 8],
    stated: new Set([3]),
    instructed: new Set(),
  };
  const check = (c: Partial<PointsContext>) => pointsProblems({ ...base, ...c });

  test("no points, a stated number, and an estimate on the scale are fine", () => {
    expect(check({})).toEqual([]);
    expect(check({ storyPoints: "3", pointsSource: "stated" })).toEqual([]);
    expect(check({ storyPoints: "5", pointsSource: "estimated" })).toEqual([]);
  });

  test("an estimate outside the scale is rejected, naming the scale", () => {
    expect(check({ storyPoints: "4", pointsSource: "estimated" })).toEqual([
      "an estimate must be one of the scale's values (1, 2, 3, 5, 8), not 4.",
    ]);
  });

  test("without a scale there is nothing to estimate from", () => {
    expect(check({ storyPoints: "3", pointsSource: "estimated", scale: [] })[0]).toContain(
      "there is no story point scale",
    );
    expect(pointSources([])).toEqual(["stated"]);
    expect(pointSources([3])).toEqual(["stated", "estimated"]);
  });

  test("a stated number the input does not give as points is rejected", () => {
    expect(check({ storyPoints: "8", pointsSource: "stated" })[0]).toContain(
      "storyPoints 8 is not given as story points in the input",
    );
  });

  test("an estimate on an existing ticket is rejected; stated points pass", () => {
    const update = { kind: "update_issue", scale: [1, 2, 3, 5, 8] };
    expect(check({ ...update, storyPoints: "5", pointsSource: "estimated" })[0]).toContain(
      "never estimate an existing ticket",
    );
    expect(
      check({ ...update, storyPoints: "5", pointsSource: "stated", stated: new Set([5]) }),
    ).toEqual([]);
    expect(
      check({
        ...update,
        storyPoints: "5",
        pointsSource: "stated",
        stated: new Set([5]),
        current: 5,
      })[0],
    ).toContain("already has 5 points");
  });

  test("an Epic gets no points", () => {
    expect(check({ storyPoints: "3", pointsSource: "stated", epic: true })).toEqual([
      "an Epic does not get story points; leave storyPoints empty.",
    ]);
  });

  test("shape errors: no number, out of range, a source without a number, a number without a source", () => {
    expect(check({ storyPoints: "lots", pointsSource: "stated" })[0]).toContain("must be a number");
    expect(check({ storyPoints: "2000", pointsSource: "stated" })[0]).toContain("out of range");
    expect(check({ pointsSource: "estimated" })[0]).toContain("storyPoints is empty");
    expect(check({ storyPoints: "3" })).toEqual([
      "storyPoints needs pointsSource stated or estimated.",
    ]);
  });

  test("the user's points on the proposal it revises may be kept; an estimate there may not pass as stated", () => {
    expect(
      check({ storyPoints: "13", pointsSource: "stated", kept: { points: 13, cleared: false } }),
    ).toEqual([]);
    // Another proposal's value, or an estimate (kept as null), is no stated number.
    expect(
      check({ storyPoints: "13", pointsSource: "stated", kept: { points: null, cleared: false } }),
    ).not.toEqual([]);
  });

  test("points the user cleared stay cleared unless their instructions give a number", () => {
    const kept = { points: null, cleared: true };
    expect(check({ storyPoints: "5", pointsSource: "estimated", kept })[0]).toContain(
      "the user cleared this ticket's story points",
    );
    // Stated in the pasted input only: still cleared.
    expect(check({ storyPoints: "3", pointsSource: "stated", kept })).not.toEqual([]);
    expect(
      check({ storyPoints: "3", pointsSource: "stated", kept, instructed: new Set([3]) }),
    ).toEqual([]);
    expect(check({ kept })).toEqual([]);
  });
});

describe("createPoints (payload building, D55)", () => {
  const none = { storyPoints: null, storyPointsEstimated: false, storyPointsCleared: false };

  test("stated and estimated points; an estimate is marked", () => {
    expect(createPoints("3", "stated", { epic: false, smallAsk: false })).toEqual({
      ...none,
      storyPoints: 3,
    });
    expect(createPoints("5", "estimated", { epic: false, smallAsk: false })).toEqual({
      ...none,
      storyPoints: 5,
      storyPointsEstimated: true,
    });
    expect(createPoints(null, null, { epic: false, smallAsk: false })).toEqual(none);
  });

  test("a small ask without stated points gets the default when one is set", () => {
    const opts = { epic: false, smallAsk: true, defaultPoints: 1 };
    expect(createPoints("5", "estimated", opts)).toEqual({ ...none, storyPoints: 1 });
    expect(createPoints(null, null, opts)).toEqual({ ...none, storyPoints: 1 });
    // Stated points win over the default.
    expect(createPoints("3", "stated", opts)).toEqual({ ...none, storyPoints: 3 });
    // Without a default the suggestion stays.
    expect(createPoints("5", "estimated", { ...opts, defaultPoints: null })).toEqual({
      ...none,
      storyPoints: 5,
      storyPointsEstimated: true,
    });
  });

  test("cleared points stay cleared: no estimate, no default; stated points end the clear", () => {
    const opts = { epic: false, smallAsk: true, defaultPoints: 1, cleared: true };
    expect(createPoints("5", "estimated", opts)).toEqual({ ...none, storyPointsCleared: true });
    expect(createPoints(null, null, opts)).toEqual({ ...none, storyPointsCleared: true });
    expect(createPoints("3", "stated", opts)).toEqual({ ...none, storyPoints: 3 });
  });

  test("an Epic never gets points, not even a default", () => {
    expect(createPoints("3", "stated", { epic: true, smallAsk: false })).toEqual(none);
  });
});

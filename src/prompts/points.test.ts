import { describe, expect, test } from "bun:test";
import {
  aboutPoints,
  createPoints,
  keptPoints,
  ownNumbers,
  ownStatedNumbers,
  type PointsContext,
  parsePoints,
  pointSources,
  pointsKey,
  pointsProblems,
  statedNumbers,
  withoutInlineValues,
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

  test("stray punctuation and whitespace around the number are ignored", () => {
    expect(parsePoints(": 2")).toBe(2);
    expect(parsePoints(" 3 ")).toBe(3);
    expect(parsePoints("3 points")).toBe(3);
    expect(parsePoints("3.")).toBe(3);
    expect(parsePoints('"5"')).toBe(5);
    expect(parsePoints("~8 SP")).toBe(8);
    expect(parsePoints(".5")).toBe(0.5);
    expect(parsePoints("three")).toBe(3);
  });

  test("empty, punctuation and the words for none are no points", () => {
    for (const v of [
      "",
      " ",
      ":",
      "-",
      "...",
      "(none)",
      "none",
      "null",
      "N/A",
      "n/a",
      null,
      undefined,
    ])
      expect(parsePoints(v)).toBeNull();
  });

  test("anything else that is not a number of points is dropped, not invalid", () => {
    expect(parsePoints("abc")).toBeNull();
    expect(parsePoints("3-5")).toBeNull();
    expect(parsePoints("3 or 5")).toBeNull();
    expect(parsePoints({})).toBeNull();
    expect(parsePoints(Number.NaN)).toBeNull();
  });

  test("a number out of range stays a number, for the checks to refuse", () => {
    expect(parsePoints("-2")).toBe(-2);
    expect(parsePoints("2000")).toBe(2000);
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

  test("a bare number has no cue, so pasted text giving one does not state points", () => {
    expect(stated("1")).toEqual([]);
    expect(stated("set it to 3")).toEqual([]);
  });

  test('"make it (a) N" and "make KEY (a) N" are cues when the number ends the phrase', () => {
    expect(stated("make it a 5")).toEqual([5]);
    expect(stated("make PAY-12 a 5.")).toEqual([5]);
    expect(stated("ok, make it 3 points")).toEqual([3]);
    expect(stated("make it three, then")).toEqual([3]);
    expect(stated("make it 2 weeks")).toEqual([]);
    expect(stated("make 2 copies")).toEqual([]);
    expect(stated("make it one of the release tickets")).toEqual([]);
  });
});

describe("ownStatedNumbers: un-cued numbers count only while points are the topic", () => {
  const own = (texts: string[], topic = false) =>
    [...ownStatedNumbers(texts, topic)].sort((a, b) => a - b);

  test("by form: just a number, or a short set/make", () => {
    for (const words of [
      "1",
      " 1 ",
      "1 point",
      "3.",
      "set it to 3",
      "make PAY-12 a 5",
      "make it 2",
    ])
      expect({ words, n: own([words]).length }).toEqual({ words, n: 1 });
  });

  test("other numbers only with the topic", () => {
    expect(own(["send 2 reports to PAY-12"])).toEqual([]);
    expect(own(["move PAY-12 to sprint 24"])).toEqual([]);
    expect(own(["PAY-12 due Oct 5"])).toEqual([]);
    expect(own(["go with 2 I think"])).toEqual([]);
    expect(own(["go with 2 I think"], true)).toEqual([2]);
    // Cued numbers always count, «…» values included; un-cued ones in values never.
    expect(own(["Dana says «it's a 2-pointer»"])).toEqual([2]);
    expect(own(["set PAY-2 to «13»"], true)).toEqual([]);
  });

  test("aboutPoints: points, story points, SP, estimates, pointers; not inside «…» values", () => {
    for (const t of ["why no story points?", "re-estimate it", "a 3-pointer", "SP?", "the points"])
      expect({ t, about: aboutPoints(t) }).toEqual({ t, about: true });
    expect(aboutPoints("send 2 reports")).toBe(false);
    expect(aboutPoints("Dana wrote «5 points»")).toBe(false);
  });
});

describe("ownNumbers: every number of a text, cue or not", () => {
  const own = (...texts: string[]) => [...ownNumbers(texts)].sort((a, b) => a - b);

  test("an answer, a typed instruction, a number word", () => {
    expect(own("1")).toEqual([1]);
    expect(own(" 1 ")).toEqual([1]);
    expect(own("set it to 3")).toEqual([3]);
    expect(own("make PAY-12 a 5")).toEqual([5]);
    expect(own("make it three")).toEqual([3]);
    expect(own("0.5 please")).toEqual([0.5]);
    expect(own("eighteen")).toEqual([18]);
  });

  test("issue keys, ISO dates, times and digits inside a word still do not count", () => {
    expect(own("pay-12 and PAY-7, due 2026-10-09 at 14:30")).toEqual([]);
    expect(own("the Q3 numbers for v2, someone said")).toEqual([]);
  });

  test("«…» values pasted inline are left out of typed text; none, no change", () => {
    expect(own(withoutInlineValues("make it 3, Dana said «send me two reports»"))).toEqual([3]);
    expect(own(withoutInlineValues("make it 3 «and 5 more"))).toEqual([3]);
    expect(withoutInlineValues("make it 3")).toBe("make it 3");
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
    // The value the ticket has changes nothing: payload building drops it.
    expect(check({ ...update, storyPoints: "5", pointsSource: "stated", current: 5 })).toEqual([]);
  });

  test("an Epic gets no points", () => {
    expect(check({ storyPoints: "3", pointsSource: "stated", epic: true })).toEqual([
      "an Epic does not get story points; leave storyPoints empty.",
    ]);
  });

  test("shape errors: out of range, a number without a source; no number is no points", () => {
    // Text that is no number drops the optional points: never a repair (eval, 2026-10-15).
    for (const storyPoints of ["lots", ":", "abc", "(none)"])
      expect(check({ storyPoints, pointsSource: "stated" })).toEqual([]);
    expect(check({ pointsSource: "estimated" })).toEqual([]);
    expect(check({ storyPoints: "2000", pointsSource: "stated" })[0]).toContain("out of range");
    expect(check({ storyPoints: "-2", pointsSource: "stated" })[0]).toContain("out of range");
    expect(check({ storyPoints: ": 2", pointsSource: "estimated", scale: [3, 5] })[0]).toContain(
      "an estimate must be one of the scale's values",
    );
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

  test("an update with a number nobody gave asks the user instead of suggesting an estimate", () => {
    const [problem] = check({ kind: "update_issue", storyPoints: "2", pointsSource: "stated" });
    expect(problem).toContain("storyPoints 2 is not given as story points in the input");
    expect(problem).toContain("ask the user for the number in question");
    expect(problem).not.toContain("pointsSource estimated");
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

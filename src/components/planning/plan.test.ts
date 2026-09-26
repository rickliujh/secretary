import { describe, expect, test } from "bun:test";
import {
  capacityPercent,
  capacityTone,
  orderPicks,
  parseCapacity,
  planningDue,
  proposedMessage,
  toProposal,
} from "./plan";

const sprint = (end: string | null) => ({ id: 1, name: "S1", start: null, end });

describe("orderPicks", () => {
  test("model order first, then the user's additions in list order", () => {
    const checked = new Set(["B", "D", "A", "C"]);
    expect(orderPicks(["C", "A", "X"], checked, ["A", "B", "C", "D"])).toEqual([
      "C",
      "A",
      "B",
      "D",
    ]);
  });

  test("unchecked model picks are dropped", () => {
    expect(orderPicks(["A", "B"], new Set(["B"]), ["A", "B"])).toEqual(["B"]);
  });
});

describe("toProposal", () => {
  test("re-checked deferrals are no longer deferred", () => {
    const p = toProposal({
      goal: "  Ship login ",
      checked: new Set(["A", "D"]),
      candidateKeys: ["A", "B", "D"],
      plan: {
        picks: [{ key: "A", reason: "r" }],
        deferred: [
          { key: "B", reason: "later" },
          { key: "D", reason: "blocked" },
        ],
        risks: ["A may slip"],
      },
    });
    expect(p).toEqual({
      goal: "Ship login",
      picks: ["A", "D"],
      deferred: [{ key: "B", reason: "later" }],
      risks: ["A may slip"],
    });
  });
});

describe("parseCapacity", () => {
  test("numbers, empty and junk", () => {
    expect(parseCapacity(" 13 ")).toBe(13);
    expect(parseCapacity("7.5")).toBe(7.5);
    expect(parseCapacity("")).toBeNull();
    expect(parseCapacity("abc")).toBeNull();
    expect(parseCapacity("-2")).toBeNull();
  });
});

describe("capacityTone", () => {
  test("within capacity, over it, and over the slack", () => {
    expect(capacityTone(10, 10)).toBe("success");
    expect(capacityTone(11, 10)).toBe("warning");
    // 10 * 1.15 is 11.5 once rounded like the prompt's check, so 11.5 still fits.
    expect(capacityTone(11.5, 10)).toBe("warning");
    expect(capacityTone(12, 10)).toBe("danger");
  });

  test("unknown capacity is neutral", () => {
    expect(capacityTone(40, null)).toBe("neutral");
  });

  test("percent is capped and safe without capacity", () => {
    expect(capacityPercent(5, 10)).toBe(50);
    expect(capacityPercent(30, 10)).toBe(100);
    expect(capacityPercent(3, null)).toBe(0);
    expect(capacityPercent(3, 0)).toBe(0);
  });
});

describe("planningDue", () => {
  // 2026-09-24 is a Thursday.
  const today = "2026-09-24";

  test("ending within two working days", () => {
    expect(planningDue({ ending: sprint("2026-09-24"), next: null }, today)).toBe(true);
    // Monday is the second working day after Thursday; Tuesday is the third.
    expect(planningDue({ ending: sprint("2026-09-28"), next: null }, today)).toBe(true);
    expect(planningDue({ ending: sprint("2026-09-29"), next: null }, today)).toBe(false);
  });

  test("already ended only with a next sprint", () => {
    expect(planningDue({ ending: sprint("2026-09-20"), next: null }, today)).toBe(false);
    expect(planningDue({ ending: sprint("2026-09-20"), next: sprint("2026-10-04") }, today)).toBe(
      true,
    );
  });

  test("no ending sprint or no end date", () => {
    expect(planningDue({ ending: null, next: sprint("2026-10-04") }, today)).toBe(false);
    expect(planningDue({ ending: sprint(null), next: null }, today)).toBe(false);
  });
});

describe("proposedMessage", () => {
  test("counts moves and names issues already there", () => {
    expect(proposedMessage({ proposals: 1, alreadyThere: [] })).toBe("1 move to approve");
    expect(proposedMessage({ proposals: 3, alreadyThere: ["A-1", "A-2"] })).toBe(
      "3 moves to approve; A-1, A-2 were already in the sprint",
    );
    expect(proposedMessage({ proposals: 0, alreadyThere: ["A-1"] })).toBe(
      "Nothing to move; A-1 was already in the sprint",
    );
  });
});

import { describe, expect, test } from "bun:test";
import { awayDateProblem, awayLabel, isAway, isRealDate, MAX_AWAY_DAYS } from "./away";

describe("away dates (D47)", () => {
  test("away through the date itself; a past date is ignored", () => {
    expect(isAway("2026-10-14", "2026-10-14")).toBe(true);
    expect(isAway("2026-10-13", "2026-10-14")).toBe(false);
    expect(isAway(null, "2026-10-14")).toBe(false);
    expect(awayLabel("2026-10-14", "2026-10-03")).toBe("Away until 14 Oct");
    expect(awayLabel("2026-10-01", "2026-10-03")).toBeNull();
  });

  test("a proposed date must be real, not past and not absurdly far", () => {
    const today = "2026-10-03";
    expect(awayDateProblem("2026-10-14", today)).toBeNull();
    expect(awayDateProblem(today, today)).toBeNull();
    expect(awayDateProblem("2026-02-30", today)).toContain("not a real date");
    expect(awayDateProblem("14 Oct", today)).toContain("not a real date");
    expect(awayDateProblem("2026-10-02", today)).toContain("in the past");
    expect(awayDateProblem("2027-10-14", today)).toContain(`more than ${MAX_AWAY_DAYS} days`);
    expect(isRealDate("2028-02-29")).toBe(true);
  });
});

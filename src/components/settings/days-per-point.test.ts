import { describe, expect, test } from "bun:test";
import { DaysPerPoint, decimal } from "./days-per-point";

describe("days per point field (D57)", () => {
  test("a decimal comma or point, within bounds, or empty", () => {
    expect(DaysPerPoint.safeParse("0,5").success).toBe(true);
    expect(decimal("0,5")).toBe(0.5);
    expect(DaysPerPoint.safeParse(" 0.5 ").success).toBe(true);
    expect(DaysPerPoint.safeParse(",25").success).toBe(true);
    expect(DaysPerPoint.safeParse("").success).toBe(true);
    expect(DaysPerPoint.safeParse("0,01").success).toBe(false);
    expect(DaysPerPoint.safeParse("11").success).toBe(false);
    expect(DaysPerPoint.safeParse("1,2,3").success).toBe(false);
    expect(DaysPerPoint.safeParse("half").success).toBe(false);
  });
});

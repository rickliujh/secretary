import { describe, expect, test } from "bun:test";
import { addBusinessDays, daysBetween, localDate, localDateOf } from "./dates";

describe("dates", () => {
  test("business days skip weekends", () => {
    // 2026-09-25 is a Friday.
    expect(addBusinessDays("2026-09-25", 1)).toBe("2026-09-28");
    expect(addBusinessDays("2026-09-25", 3)).toBe("2026-09-30");
    expect(daysBetween("2026-09-20", "2026-09-25")).toBe(5);
  });

  test("whole days count timestamps by their date part", () => {
    expect(daysBetween("2026-09-20T23:59:00.000+0100", "2026-09-21")).toBe(1);
    expect(daysBetween("2026-09-25", "2026-09-20")).toBe(-5);
    // Across a daylight saving change.
    expect(daysBetween("2026-10-24", "2026-10-26")).toBe(2);
  });

  test("local dates keep plain dates and convert timestamps", () => {
    expect(localDateOf("2026-09-10")).toBe("2026-09-10");
    const at = new Date(2026, 8, 10, 23, 30);
    expect(localDateOf(at.toISOString())).toBe(localDate(at));
    expect(localDate(at)).toBe("2026-09-10");
  });
});

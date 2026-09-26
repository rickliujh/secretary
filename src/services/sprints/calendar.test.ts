import { describe, expect, test } from "bun:test";
import { buildCalendar, datePart, quarterOf, type SprintInfo } from "./calendar";

/** Two-week sprints on board 7: Payments 9 starts 2026-06-22, Payments 15 is active. */
const payments: SprintInfo[] = Array.from({ length: 7 }, (_, i) => {
  const n = 9 + i;
  const start = new Date(Date.UTC(2026, 5, 22 + i * 14)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(2026, 5, 22 + i * 14 + 14)).toISOString().slice(0, 10);
  return {
    id: 30 + n,
    name: `Payments ${n}`,
    state: n === 15 ? "active" : "closed",
    boardId: 7,
    start,
    end,
  };
});

describe("quarterOf", () => {
  test("calendar quarters", () => {
    expect(quarterOf("2026-09-14").label).toBe("Q3 2026 (Jul–Sep)");
    expect(quarterOf("2026-10-12").label).toBe("Q4 2026 (Oct–Dec)");
  });

  test("a fiscal year starting in July is named after the year it ends in", () => {
    expect(quarterOf("2026-07-01", 7).label).toBe("FY2027 Q1 (Jul–Sep 2026)");
    expect(quarterOf("2027-01-15", 7).label).toBe("FY2027 Q3 (Jan–Mar 2027)");
    expect(quarterOf("2026-11-30", 11).label).toBe("FY2027 Q1 (Nov–Jan 2026)");
    expect(quarterOf("2027-01-02", 11).label).toBe("FY2027 Q1 (Nov–Jan 2026)");
  });
});

describe("buildCalendar", () => {
  test("positions count sprints by start within the quarter, projections included", () => {
    const cal = buildCalendar(payments, {
      today: "2026-09-24",
      completeBoards: new Set([7]),
      pastDays: 90,
    });
    const at = (name: string) => cal.find((s) => s.name === name);
    // Payments 10 starts 2026-07-06: the first sprint starting in Q3.
    expect(at("Payments 10")).toMatchObject({ quarter: "Q3 2026 (Jul–Sep)", ordinal: 1 });
    expect(at("Payments 15")).toMatchObject({ state: "active", start: "2026-09-14", ordinal: 6 });
    expect(at("projected 1 after Payments 15")).toMatchObject({
      start: "2026-09-28",
      end: "2026-10-12",
      quarter: "Q3 2026 (Jul–Sep)",
      ordinal: 7,
    });
    expect(at("projected 3 after Payments 15")).toMatchObject({
      start: "2026-10-26",
      end: "2026-11-09",
      quarter: "Q4 2026 (Oct–Dec)",
      ordinal: 2,
    });
  });

  test("without the full history there are no positions, only quarters", () => {
    const cal = buildCalendar(payments.slice(-2), { today: "2026-09-24" });
    expect(cal.every((s) => s.ordinal === null)).toBe(true);
    expect(cal[0]?.quarter).toBe("Q3 2026 (Jul–Sep)");
  });

  test("keeps a window around today and does not project idle boards", () => {
    const cal = buildCalendar(payments, { today: "2026-09-24" });
    expect(cal.map((s) => s.name)).not.toContain("Payments 13");
    expect(cal.map((s) => s.name)).toContain("Payments 14");
    expect(
      buildCalendar(payments, { today: "2027-03-01" }).some((s) => s.state === "projected"),
    ).toBe(false);
  });

  test("datePart keeps the date as Jira wrote it", () => {
    expect(datePart("2026-09-28T17:00:00.000+01:00")).toBe("2026-09-28");
    expect(datePart("<null>")).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import { DEFAULT_WEIGHTS } from "@/services/settings/schema";
import { dueValue, priorityValue, rank, type ScoreInput, scoreIssue, staleValue } from "./scoring";

const TODAY = "2026-09-25";
const base: ScoreInput = {
  key: "A-1",
  priority: "Medium",
  dueDate: null,
  updated: "2026-09-24T10:00:00Z",
  statusName: "In Progress",
  blockedBy: [],
  blocks: [],
  dependencies: [],
  pinned: false,
  override: null,
};
const reasons = (i: Partial<ScoreInput>) =>
  scoreIssue({ ...base, ...i }, DEFAULT_WEIGHTS, TODAY).contributions.map((c) => c.reason);
const points = (i: Partial<ScoreInput>, factor: string) =>
  scoreIssue({ ...base, ...i }, DEFAULT_WEIGHTS, TODAY).contributions.find(
    (c) => c.factor === factor,
  )?.points ?? 0;

describe("factors", () => {
  test("priority maps Jira names, unknown sits in the middle", () => {
    expect(priorityValue("Highest")).toBe(1);
    expect(priorityValue("low")).toBe(0.25);
    expect(priorityValue(null)).toBe(0.4);
    expect(reasons({ priority: "High" })).toContain("High priority");
  });

  test("due proximity: overdue and today count fully, two weeks out counts nothing", () => {
    expect(dueValue("2026-09-20", TODAY)).toEqual({ value: 1, daysLeft: -5 });
    expect(dueValue("2026-09-25", TODAY).value).toBe(1);
    expect(dueValue("2026-10-02", TODAY).value).toBeCloseTo(0.5);
    expect(dueValue("2026-10-30", TODAY).value).toBe(0);
    expect(reasons({ dueDate: "2026-09-20" })).toContain("5 days overdue");
    expect(reasons({ dueDate: "2026-09-26" })).toContain("Due in 1 day");
  });

  test("blocked by links, a blocked status or a blocked dependency; blocking scales with count", () => {
    expect(reasons({ blockedBy: ["OPS-7"] })).toContain("Blocked by OPS-7");
    expect(reasons({ statusName: "Blocked" })).toContain("Status is Blocked");
    expect(
      reasons({
        dependencies: [{ label: "x", externalRef: null, overdueDays: 0, status: "blocked" }],
      }),
    ).toContain("A dependency is blocked");
    expect(points({ blocks: ["B-1"] }, "blocking")).toBeCloseTo(DEFAULT_WEIGHTS.blocking / 3);
    expect(points({ blocks: ["B-1", "B-2", "B-3", "B-4"] }, "blocking")).toBe(
      DEFAULT_WEIGHTS.blocking,
    );
  });

  test("staleness starts after a week of no updates", () => {
    expect(staleValue("2026-09-20T00:00:00Z", TODAY).value).toBe(0);
    expect(staleValue("2026-08-26T00:00:00Z", TODAY).value).toBe(1);
    expect(reasons({ updated: "2026-09-01T00:00:00Z" })).toContain("No updates for 24 days");
  });

  test("overdue dependencies, pins and overrides", () => {
    expect(
      reasons({
        dependencies: [
          { label: "Platform", externalRef: "INC0012345", overdueDays: 3, status: "waiting" },
        ],
      }),
    ).toContain("Waiting on Platform (INC0012345), 3 days overdue");
    expect(points({ pinned: true }, "pinned")).toBe(DEFAULT_WEIGHTS.pinned);
    expect(points({ override: -2 }, "override")).toBe(-2);
    expect(reasons({ override: 2 })).toContain("Your adjustment +2");
  });

  test("the score is the sum of contributions, largest reason first", () => {
    const s = scoreIssue({ ...base, priority: "Highest", dueDate: TODAY }, DEFAULT_WEIGHTS, TODAY);
    expect(s.score).toBe(DEFAULT_WEIGHTS.priority + DEFAULT_WEIGHTS.due);
    expect(s.contributions[0]?.factor).toBe("due");
  });
});

describe("rank", () => {
  const issues: ScoreInput[] = [
    { ...base, key: "DUE-1", priority: "Low", dueDate: TODAY },
    { ...base, key: "PRI-1", priority: "Highest" },
    { ...base, key: "OLD-1", priority: "Low", updated: "2026-08-01T00:00:00Z" },
  ];

  test("changing a weight reorders Top focus predictably (Phase 5 checklist)", () => {
    expect(rank(issues, DEFAULT_WEIGHTS, TODAY).map((s) => s.key)).toEqual([
      "DUE-1",
      "PRI-1",
      "OLD-1",
    ]);
    expect(rank(issues, { ...DEFAULT_WEIGHTS, due: 0 }, TODAY).map((s) => s.key)).toEqual([
      "PRI-1",
      "OLD-1",
      "DUE-1",
    ]);
    expect(rank(issues, { ...DEFAULT_WEIGHTS, stale: 10 }, TODAY)[0]?.key).toBe("OLD-1");
  });

  test("a pin wins with default weights", () => {
    expect(
      rank(
        [...issues, { ...base, key: "PIN-1", priority: "Lowest", pinned: true }],
        DEFAULT_WEIGHTS,
        TODAY,
      )[0]?.key,
    ).toBe("PIN-1");
  });
});

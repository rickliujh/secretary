import { describe, expect, test } from "bun:test";
import {
  chooseRate,
  halfDays,
  type LoadIssue,
  sprintFit,
  sprintWhen,
  userLoad,
  velocityRate,
  workingDaysBetween,
  workingDaysLeft,
} from "./fit";

// 2026-10-15 is a Thursday; the sprint ends on Monday 2026-10-19.
const sprint = { start: "2026-10-06", end: "2026-10-19" };
const half = { daysPerPoint: 0.5, source: "settings" as const };
const load = (points: number, count = 2, unestimated = 0) => ({ count, points, unestimated });

describe("working days", () => {
  test("Monday to Friday, both ends included", () => {
    expect(workingDaysBetween("2026-10-15", "2026-10-19")).toBe(3);
    expect(workingDaysBetween("2026-10-17", "2026-10-18")).toBe(0);
    expect(workingDaysBetween("2026-10-19", "2026-10-15")).toBe(0);
  });

  test("from today, counting today in full", () => {
    expect(workingDaysLeft(sprint, "2026-10-15")).toBe(3);
  });

  test("today is the last day: one day left", () => {
    expect(workingDaysLeft(sprint, "2026-10-19")).toBe(1);
    expect(sprintWhen(sprint, "2026-10-19")).toBe("ends Mon 19 Oct, 1 working day left");
  });

  test("the end has passed: none left, and it says it is not closed yet", () => {
    expect(workingDaysLeft(sprint, "2026-10-21")).toBe(0);
    expect(sprintWhen(sprint, "2026-10-21")).toBe("ended Mon 19 Oct, not closed yet");
  });

  test("a sprint that has not started counts from its start", () => {
    expect(workingDaysLeft({ start: "2026-10-19", end: "2026-10-23" }, "2026-10-15")).toBe(5);
  });

  test("names the end and the days left", () => {
    expect(sprintWhen({ start: null, end: "2026-10-17" }, "2026-10-15")).toBe(
      "ends Sat 17 Oct, 2 working days left",
    );
  });
});

describe("load", () => {
  const issue = (o: Partial<LoadIssue>): LoadIssue => ({
    assignee: "me",
    sprint: "S1",
    statusCategory: "new",
    issueType: "Story",
    storyPoints: 1,
    ...o,
  });

  test("the user's open tickets in the sprint, as sprint points count them", () => {
    const issues = [
      issue({}),
      issue({ statusCategory: "indeterminate", storyPoints: 3 }),
      issue({ storyPoints: null }),
      issue({ statusCategory: "done" }),
      issue({ assignee: "ana" }),
      issue({ sprint: "S2" }),
      issue({ issueType: "Epic" }),
      issue({ isSubtask: true }),
      issue({ stale: true }),
    ];
    expect(userLoad(issues, "S1", "me")).toEqual({ count: 3, points: 4, unestimated: 1 });
  });

  test("no user, no load", () => {
    expect(userLoad([issue({})], "S1", null)).toEqual({ count: 0, points: 0, unestimated: 0 });
  });
});

describe("rate", () => {
  test("Settings win over velocity", () => {
    const derived = velocityRate([{ start: "2026-09-21", end: "2026-10-02", points: 10 }]);
    expect(chooseRate(0.5, derived)).toEqual(half);
    expect(chooseRate(null, derived)).toEqual(derived);
  });

  test("velocity: working days of the last sprints over the points finished", () => {
    // Two two-week sprints (10 working days each), 8 and 12 points.
    expect(
      velocityRate([
        { start: "2026-09-21", end: "2026-10-02", points: 8 },
        { start: "2026-09-07", end: "2026-09-18", points: 12 },
      ]),
    ).toEqual({ daysPerPoint: 1, source: "velocity", sprints: 2 });
  });

  test("no finished points or no sprints: no rate", () => {
    expect(velocityRate([{ start: "2026-09-21", end: "2026-10-02", points: 0 }])).toBeNull();
    expect(velocityRate([])).toBeNull();
    expect(chooseRate(null, null)).toBeNull();
  });

  test("half days", () => {
    expect(halfDays(1.2)).toBe(1);
    expect(halfDays(1.3)).toBe(1.5);
    expect(halfDays(3.5)).toBe(3.5);
  });
});

describe("fit", () => {
  const base = { daysLeft: 3, rate: half, me: "me" };

  test("FR-16 AC: two 1-point tickets and a new 2-pointer at half a day a point fit", () => {
    const f = sprintFit({
      ...base,
      load: load(2),
      ticket: { label: "New", points: 2, assignee: null },
    });
    expect(f.verdict).toBe("fits");
    expect(f.days).toBe(2);
    expect(f.headline).toBe("Fits: about 2 of 3 working days");
  });

  test("FR-16 AC: with a third 3-point ticket it is over", () => {
    const f = sprintFit({
      ...base,
      load: load(5, 3),
      ticket: { label: "New", points: 2, assignee: "me" },
    });
    expect(f.verdict).toBe("over");
    expect(f.headline).toBe("Over: about 3.5 of 3 working days");
  });

  test("tight between 85 percent and all of the days left", () => {
    // 5.5 points x 0.5 = 2.75 days of 3: above 2.55, within 3.
    const f = sprintFit({
      ...base,
      load: load(3.5),
      ticket: { label: "New", points: 2, assignee: null },
    });
    expect(f.verdict).toBe("tight");
  });

  test("today is the last day: one day left", () => {
    const f = sprintFit({
      ...base,
      daysLeft: 1,
      load: load(1, 1),
      ticket: { label: "New", points: 1, assignee: null },
    });
    expect(f).toMatchObject({ verdict: "tight", days: 1 });
    expect(
      sprintFit({
        ...base,
        daysLeft: 1,
        load: load(0, 0),
        ticket: { label: "x", points: 1, assignee: null },
      }).verdict,
    ).toBe("fits");
  });

  test("the end has passed: any need is over", () => {
    const f = sprintFit({
      ...base,
      daysLeft: 0,
      ended: true,
      load: load(0, 0),
      ticket: { label: "New", points: 1, assignee: null },
    });
    expect(f.verdict).toBe("over");
    expect(f.headline).toBe("Over: the sprint has ended but is not closed yet");
  });

  test("no rate: unknown, with points and days and a pointer to the setting", () => {
    const f = sprintFit({
      ...base,
      rate: null,
      load: load(2),
      ticket: { label: "New", points: 2, assignee: null },
    });
    expect(f).toMatchObject({ verdict: "unknown", missing: "rate", days: null, points: 4 });
    expect(f.headline).toBe("4 points, 3 working days left; set what a point means to size it");
    expect(f.details.at(-1)).toBe("No rate yet: set what a point means in Settings");
  });

  test("unestimated tickets are counted and named", () => {
    const f = sprintFit({
      ...base,
      load: load(2, 3, 1),
      ticket: { label: "New", points: 1, assignee: null },
    });
    expect(f.unestimated).toBe(1);
    expect(f.headline).toBe("Fits: about 1.5 of 3 working days, plus 1 unestimated");
    expect(f.details[0]).toBe("Your open tickets there: 3, 2 points, about 1 day, 1 unestimated");
  });

  test("a ticket without points: add points to size it, unless the sprint is already full", () => {
    const open = sprintFit({
      ...base,
      load: load(2),
      ticket: { label: "New", points: null, assignee: null },
    });
    expect(open).toMatchObject({
      verdict: "unknown",
      missing: "points",
      already: false,
      unestimated: 1,
    });
    expect(open.headline).toBe(
      "Add points to size it: about 1 of 3 working days so far, plus 1 unestimated",
    );
    const full = sprintFit({
      ...base,
      load: load(7),
      ticket: { label: "New", points: null, assignee: null },
    });
    expect(full).toMatchObject({ verdict: "over", already: true, missing: null });
    expect(full.headline).toBe(
      "Over already without this ticket: about 3.5 of 3 working days, plus 1 unestimated",
    );
    const tight = sprintFit({
      ...base,
      load: load(5.5),
      ticket: { label: "New", points: null, assignee: null },
    });
    expect(tight).toMatchObject({ verdict: "tight", already: true });
  });

  test("a ticket assigned to someone else is shown but not counted", () => {
    const f = sprintFit({
      ...base,
      load: load(2),
      ticket: { label: "New", points: 8, assignee: "ana" },
    });
    expect(f.points).toBe(2);
    expect(f.verdict).toBe("fits");
    expect(f.details).toContain("This ticket: assigned to ana, not counted");
  });

  test("other new tickets of the thread that join count too; another assignee's do not", () => {
    const f = sprintFit({
      ...base,
      load: load(2),
      others: [
        { label: "Export", points: 2, assignee: null },
        { label: "Docs", points: 5, assignee: "ana" },
        { label: "Check", points: null, assignee: "me" },
      ],
      ticket: { label: "New", points: 1, assignee: null },
    });
    expect(f.points).toBe(5);
    expect(f.verdict).toBe("fits");
    expect(f.unestimated).toBe(1);
    expect(f.details[1]).toBe(
      "Other new tickets here that join it: Export (2 points, about 1 day); Docs (assigned to ana, not counted); Check (no points)",
    );
    expect(f.details[2]).toBe("This ticket: 1 point, about 0.5 days");
  });

  test("the load alone, as Today shows it", () => {
    const f = sprintFit({
      ...base,
      load: load(4),
      rate: { daysPerPoint: 1, source: "velocity", sprints: 3 },
    });
    expect(f).toMatchObject({ verdict: "over", days: 4, ticket: null });
    expect(f.headline).toBe("Over: about 4 of 3 working days");
    expect(f.details.at(-1)).toBe("1 point is about 1 day, from your last 3 sprints");
  });
});

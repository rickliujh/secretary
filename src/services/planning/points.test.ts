import { describe, expect, test } from "bun:test";
import { type PointsIssue, pickSprint, sprintPoints } from "./points";

const i = (key: string, p: Partial<PointsIssue> = {}): PointsIssue => ({
  key,
  summary: key,
  issueType: "Story",
  isSubtask: false,
  status: "In Progress",
  statusCategory: "indeterminate",
  assignee: "me",
  assigneeDisplay: "Me",
  sprint: "PAY 15",
  storyPoints: 3,
  ...p,
});

const issues = [
  i("A-1"),
  i("A-2", { storyPoints: 5, statusCategory: "done", status: "Done" }),
  i("A-3", { storyPoints: null }),
  i("A-4", { storyPoints: 0 }),
  i("A-5", { assignee: "ana", assigneeDisplay: "Ana", storyPoints: 8 }),
  i("A-6", { isSubtask: true, storyPoints: 2 }),
  i("EP-1", { issueType: "Epic", storyPoints: 40 }),
  i("B-1", { sprint: "PAY 16", storyPoints: 13 }),
];

describe("sprintPoints", () => {
  test("my points: total, done, remaining; zero is an estimate, null is not", () => {
    const r = sprintPoints(issues, "PAY 15", "me");
    expect(r).toMatchObject({
      total: 8,
      done: 5,
      remaining: 3,
      estimated: 3,
      unestimated: ["A-3"],
    });
    expect(r.tickets.map((t) => t.key)).toEqual(["A-2", "A-1", "A-4", "A-3"]);
  });

  test("everyone in the sprint; sub-tasks and epics left out", () => {
    expect(sprintPoints(issues, "PAY 15", null)).toMatchObject({ total: 16, done: 5 });
  });
});

describe("pickSprint", () => {
  const sprints = [
    { id: 1, name: "PAY 14", state: "closed", boardId: 1, start: null, end: null },
    { id: 2, name: "OPS 3", state: "active", boardId: 2, start: null, end: null },
    { id: 3, name: "PAY 15", state: "active", boardId: 1, start: null, end: null },
  ];
  test("the active sprint with my work, or a named one", () => {
    expect(pickSprint(sprints, issues, "me")?.name).toBe("PAY 15");
    expect(pickSprint(sprints, [], "me")?.name).toBe("OPS 3");
    expect(pickSprint(sprints, issues, "me", "pay 14")?.name).toBe("PAY 14");
    expect(pickSprint(sprints, issues, "me", "14")?.name).toBe("PAY 14");
    expect(pickSprint(sprints, issues, "me", "nope")).toBeNull();
  });
});

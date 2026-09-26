import { describe, expect, test } from "bun:test";
import type { SprintInfo } from "@/services/sprints/calendar";
import { buildCandidates, type PlanIssue, pointsOf, sprintPair, velocity } from "./logic";

const sprint = (
  id: number,
  name: string,
  state: string,
  start: string,
  end: string,
  boardId = 7,
): SprintInfo => ({
  id,
  name,
  state,
  boardId,
  start,
  end,
});
const sprints = [
  sprint(12, "Payments 12", "closed", "2026-08-03", "2026-08-17"),
  sprint(13, "Payments 13", "closed", "2026-08-17", "2026-08-31"),
  sprint(14, "Payments 14", "closed", "2026-08-31", "2026-09-14"),
  sprint(15, "Payments 15", "active", "2026-09-14", "2026-09-28"),
  sprint(17, "Payments 17", "future", "2026-10-12", "2026-10-26"),
  sprint(16, "Payments 16", "future", "2026-09-28", "2026-10-12"),
  sprint(90, "Ops 3", "future", "2026-09-28", "2026-10-12", 9),
];

const issue = (key: string, p: Partial<PlanIssue> = {}): PlanIssue => ({
  key,
  summary: key,
  issueType: "Story",
  status: "To Do",
  statusCategory: "new",
  priority: "Medium",
  storyPoints: 3,
  assignee: "me",
  epicKey: null,
  sprint: null,
  dueDate: null,
  resolved: null,
  blockedBy: [],
  waitingOn: [],
  score: 1,
  ...p,
});

describe("sprint planning logic (D30)", () => {
  test("the next sprint is the board's earliest future sprint", () => {
    const { active, next } = sprintPair(sprints, [issue("PAY-1", { sprint: "Payments 15" })], "me");
    expect(active?.name).toBe("Payments 15");
    expect(next?.name).toBe("Payments 16");
  });

  test("velocity is the user's points resolved inside each of the last three closed sprints", () => {
    const done = (key: string, resolved: string, points: number | null, assignee = "me") =>
      issue(key, { statusCategory: "done", resolved, storyPoints: points, assignee });
    const v = velocity(
      sprints,
      [
        done("A", "2026-08-10T10:00:00Z", 5),
        done("B", "2026-08-20T10:00:00Z", 8),
        done("C", "2026-08-21T10:00:00Z", null),
        done("D", "2026-09-10T10:00:00Z", 3),
        done("E", "2026-09-11T10:00:00Z", 13, "someone"),
        done("F", "2026-07-01T10:00:00Z", 20),
      ],
      "me",
      7,
    );
    expect(v.sprints).toEqual([
      { name: "Payments 14", points: 3, issues: 1, unestimated: 0 },
      { name: "Payments 13", points: 8, issues: 2, unestimated: 1 },
      { name: "Payments 12", points: 5, issues: 1, unestimated: 0 },
    ]);
    expect(v.average).toBe(5.3);
  });

  test("candidates: carry-over, already planned, ranked backlog and pickups; never epics or others' work", () => {
    const { active, next } = sprintPair(sprints, [issue("X", { sprint: "Payments 15" })], "me");
    const cands = buildCandidates({
      me: "me",
      active,
      next,
      trackedEpics: ["PAY-100"],
      issues: [
        issue("PAY-1", {
          sprint: "Payments 15",
          status: "In Progress",
          statusCategory: "indeterminate",
        }),
        issue("PAY-2", { sprint: "Payments 15", statusCategory: "done" }),
        issue("PAY-3", { sprint: "Payments 16" }),
        issue("PAY-4", { score: 2, dueDate: "2026-10-05", blockedBy: ["OPS-7"] }),
        issue("PAY-5", { score: 9 }),
        issue("PAY-100", { issueType: "Epic", score: 99 }),
        issue("PAY-6", { assignee: null, epicKey: "PAY-100", storyPoints: null }),
        issue("PAY-7", { assignee: "someone", score: 50 }),
        issue("PAY-8", { assignee: null, epicKey: null }),
      ],
    });
    expect(cands.map((c) => [c.key, c.group])).toEqual([
      ["PAY-1", "carry_over"],
      ["PAY-3", "planned"],
      ["PAY-5", "backlog"],
      ["PAY-4", "backlog"],
      ["PAY-6", "pickup"],
    ]);
    const pay4 = cands.find((c) => c.key === "PAY-4");
    expect(pay4).toMatchObject({ dueInSprint: true, blocked: ["OPS-7"] });
    expect(pointsOf(cands, ["PAY-1", "PAY-6", "NOPE"])).toEqual({
      total: 3,
      unestimated: ["PAY-6"],
    });
  });
});

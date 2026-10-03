import { describe, expect, test } from "bun:test";
import { userActiveSprint, userActiveSprints } from "./active";
import type { SprintInfo } from "./calendar";

const sprint = (id: number, name: string, state: string, boardId: number): SprintInfo => ({
  id,
  name,
  state,
  boardId,
  start: "2026-09-14",
  end: "2026-09-28",
});

const sprints = [
  sprint(1, "Ops 9", "active", 12),
  sprint(2, "Payments 15", "active", 7),
  sprint(3, "Payments 14", "closed", 7),
  sprint(4, "Data 3", "active", 20),
];
const issue = (sprint: string | null, assignee = "me", statusCategory = "new") => ({
  sprint,
  assignee,
  statusCategory,
});

describe("userActiveSprints (D29, D44)", () => {
  test("the active sprint holding most of the user's open issues comes first", () => {
    const issues = [
      issue("Ops 9"),
      issue("Payments 15"),
      issue("Payments 15"),
      issue("Payments 14"),
      issue("Data 3", "ana"),
      issue("Ops 9", "me", "done"),
      issue("Ops 9", "me", "done"),
    ];
    expect(userActiveSprints(sprints, issues, "me").map((s) => s.name)).toEqual([
      "Payments 15",
      "Ops 9",
    ]);
    expect(userActiveSprint(sprints, issues, "me")?.name).toBe("Payments 15");
  });

  test("finished work only breaks ties, so a sprint near its end still counts", () => {
    const issues = [issue("Ops 9", "me", "done"), issue("Payments 15", "me", "done")];
    expect(userActiveSprints(sprints, [...issues, issues[1] ?? issue(null)], "me")[0]?.name).toBe(
      "Payments 15",
    );
  });

  test("a sprint on a board that shows the preferred project wins", () => {
    const issues = [issue("Ops 9"), issue("Ops 9"), issue("Payments 15")];
    expect(
      userActiveSprints(sprints, issues, "me", {
        preferProject: "PAY",
        boardProjects: { "7": ["PAY"], "12": ["OPS"] },
      })[0]?.name,
    ).toBe("Payments 15");
  });

  test("none of the user's work in a sprint: empty, and the single pick falls back", () => {
    expect(userActiveSprints(sprints, [issue("Data 3", "ana")], "me")).toEqual([]);
    expect(userActiveSprints(sprints, [issue("Ops 9")], null)).toEqual([]);
    expect(userActiveSprint(sprints, [], "me")?.name).toBe("Ops 9");
    expect(userActiveSprint([], [], "me")).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import { BACKLOG, CURRENT } from "@/services/sprints/options";
import {
  baselineAfterSave,
  CURRENT_TEAM,
  changedValues,
  type EditableIssue,
  editOutcomeText,
  editProblems,
  editValues,
  labelsText,
  listText,
  parseLabelsInput,
  parsePointsInput,
  pointsText,
  sameLabels,
  sameValue,
  ticketEditSteps,
} from "./edit";

describe("points text", () => {
  test("parses numbers, a decimal comma, and empty as none", () => {
    expect(parsePointsInput("3")).toBe(3);
    expect(parsePointsInput(" 0.5 ")).toBe(0.5);
    expect(parsePointsInput("0,5")).toBe(0.5);
    expect(parsePointsInput("2.")).toBe(2);
    expect(parsePointsInput(",5")).toBe(0.5);
    expect(parsePointsInput("")).toBeNull();
    expect(parsePointsInput("  ")).toBeNull();
  });

  test("anything else is not a number of points", () => {
    for (const t of ["abc", "-1", "1e2", "1.2.3", "1001", "3 pts", "0x10"])
      expect(parsePointsInput(t)).toBeUndefined();
  });

  test("shows none as empty", () => {
    expect(pointsText(null)).toBe("");
    expect(pointsText(2.5)).toBe("2.5");
  });
});

describe("labels text", () => {
  test("splits on spaces and commas, keeps the order and drops repeats", () => {
    expect(parseLabelsInput("billing, q4  billing,,urgent\nq4")).toEqual([
      "billing",
      "q4",
      "urgent",
    ]);
    expect(parseLabelsInput("  ")).toEqual([]);
    expect(labelsText(["a", "b"])).toBe("a b");
  });

  test("compares labels in any order", () => {
    expect(sameLabels(["a", "b"], ["b", "a"])).toBe(true);
    expect(sameLabels(["a"], ["a", "b"])).toBe(false);
    expect(sameLabels([], [])).toBe(true);
  });
});

test("listText joins with commas and a last and", () => {
  expect(listText([])).toBe("");
  expect(listText(["a"])).toBe("a");
  expect(listText(["a", "b"])).toBe("a and b");
  expect(listText(["a", "b", "c"])).toBe("a, b and c");
});

describe("ticketEditSteps (D58)", () => {
  const issue: EditableIssue = {
    key: "PAY-12",
    summary: "Export invoices",
    priority: "Medium",
    dueDate: null,
    description: "line 1\r\nline 2",
    storyPoints: 3,
    labels: ["billing"],
    epicKey: "PAY-1",
  };
  const initial = editValues(issue, BACKLOG);

  test("the dialog opens with the ticket's values", () => {
    expect(initial).toEqual({
      summary: "Export invoices",
      priority: "Medium",
      dueDate: "",
      descriptionWiki: "line 1\nline 2",
      points: "3",
      labels: "billing",
      epic: "PAY-1",
      sprint: BACKLOG,
      team: "",
    });
  });

  test("nothing changed writes nothing", () => {
    expect(ticketEditSteps(issue, initial, initial)).toEqual([]);
    // The same points and labels typed differently are no change.
    expect(
      ticketEditSteps(issue, initial, { ...initial, points: "3,0", labels: " billing, billing" }),
    ).toEqual([]);
  });

  test("fields in one update, then the epic, then the sprint", () => {
    const steps = ticketEditSteps(
      issue,
      initial,
      {
        ...initial,
        summary: "Export invoices (v2)",
        dueDate: "2026-10-30",
        points: "2",
        labels: "billing q4",
        epic: "",
        sprint: "41",
      },
      { "41": "PAY 15" },
    );
    expect(steps).toEqual([
      {
        parts: ["summary", "due date", "story points", "labels"],
        action: {
          kind: "update_fields",
          issueKey: "PAY-12",
          fields: {
            summary: "Export invoices (v2)",
            dueDate: "2026-10-30",
            storyPoints: 2,
            labels: ["billing", "q4"],
          },
        },
      },
      {
        parts: ["removing the epic"],
        action: { kind: "set_epic", issueKey: "PAY-12", epicKey: null },
      },
      {
        parts: ["the move to PAY 15"],
        action: { kind: "move_to_sprint", issueKey: "PAY-12", sprintId: 41, sprintName: "PAY 15" },
      },
    ]);
  });

  test("empty points and labels clear them; empty due date and description too", () => {
    const steps = ticketEditSteps(
      { ...issue, dueDate: "2026-10-30" },
      { ...initial, dueDate: "2026-10-30" },
      { ...initial, dueDate: "", descriptionWiki: "", points: " ", labels: "" },
    );
    expect(steps[0]?.action).toEqual({
      kind: "update_fields",
      issueKey: "PAY-12",
      fields: { dueDate: null, descriptionWiki: null, storyPoints: null, labels: [] },
    });
  });

  test("points that do not parse are left unchanged", () => {
    expect(ticketEditSteps(issue, initial, { ...initial, points: "lots" })).toEqual([]);
  });

  test("Backlog moves it out of its sprint; the current sprint kept writes nothing", () => {
    const inSprint = editValues(issue, "41");
    expect(ticketEditSteps(issue, inSprint, { ...inSprint, sprint: BACKLOG })).toEqual([
      {
        parts: ["the move to the backlog"],
        action: { kind: "move_to_backlog", issueKey: "PAY-12" },
      },
    ]);
    const closed = editValues(issue, CURRENT);
    expect(ticketEditSteps(issue, closed, closed)).toEqual([]);
  });

  test("the toast says what was saved, what failed and what was not tried", () => {
    const [fields, epic, move] = ticketEditSteps(
      issue,
      initial,
      { ...initial, points: "2", labels: "billing q4", epic: "PAY-7", sprint: "41" },
      { "41": "PAY 15" },
    );
    if (!fields || !epic || !move) throw new Error("steps");
    expect(
      editOutcomeText("PAY-12", { saved: [fields, epic, move], failed: null, skipped: [] }),
    ).toEqual({
      title: "Saved story points, labels, epic PAY-7 and the move to PAY 15 on PAY-12",
    });
    expect(
      editOutcomeText(
        "PAY-12",
        { saved: [fields], failed: { step: epic, error: null }, skipped: [move] },
        "Issue PAY-7 is not an epic.",
      ),
    ).toEqual({
      title: "Could not save epic PAY-7 on PAY-12",
      description:
        "Saved story points and labels. Not tried: the move to PAY 15. Issue PAY-7 is not an epic.",
    });
    expect(
      editOutcomeText("PAY-12", { saved: [], failed: { step: fields, error: null }, skipped: [] })
        .description,
    ).toBe("Nothing was saved.");
  });

  test("a new epic is linked", () => {
    expect(ticketEditSteps(issue, initial, { ...initial, epic: "PAY-7" })).toEqual([
      { parts: ["epic PAY-7"], action: { kind: "set_epic", issueKey: "PAY-12", epicKey: "PAY-7" } },
    ]);
  });
});

describe("what a Save writes from (D58 review fixes)", () => {
  const issue: EditableIssue = {
    key: "PAY-12",
    summary: "Fix login ",
    priority: "Medium",
    dueDate: null,
    description: null,
    storyPoints: 3,
    labels: ["billing"],
    epicKey: "PAY-1",
  };
  const opened = editValues(issue, "");

  test("sameValue: the summary's end spaces, points as numbers, labels as sets", () => {
    expect(sameValue("summary", "Fix login ", "Fix login")).toBe(true);
    expect(sameValue("points", "3", "3,0")).toBe(true);
    expect(sameValue("points", "lots", "lots ")).toBe(true);
    expect(sameValue("points", "3", "")).toBe(false);
    expect(sameValue("labels", "a b", "b, a")).toBe(true);
    expect(sameValue("dueDate", "", "2026-10-30")).toBe(false);
  });

  test("an untouched field changed in Jira is not written back; a trimmed summary is untouched", () => {
    const renamed = { ...issue, summary: "Fix SSO login", priority: "High" };
    const now = editValues(renamed, "");
    // The form submits the summary trimmed.
    const values = changedValues(opened, { ...opened, summary: "Fix login" }, now);
    expect(values).toEqual(now);
    expect(ticketEditSteps(renamed, now, values)).toEqual([]);
  });

  test("a retry after a partial Save does not write again what was saved", () => {
    const submitted = { ...opened, summary: "Fix login (v2)", epic: "PAY-7" };
    const steps = ticketEditSteps(issue, opened, changedValues(opened, submitted, opened));
    expect(steps.map((s) => s.action.kind)).toEqual(["update_fields", "set_epic"]);
    // The summary was written, the epic failed.
    const baseline = baselineAfterSave(opened, submitted, steps.slice(0, 1));
    expect(baseline).toEqual({ ...opened, summary: "Fix login (v2)" });
    const saved = { ...issue, summary: "Fix login (v2)" };
    const now = editValues(saved, "");
    expect(ticketEditSteps(saved, now, changedValues(baseline, submitted, now))).toEqual([
      { parts: ["epic PAY-7"], action: { kind: "set_epic", issueKey: "PAY-12", epicKey: "PAY-7" } },
    ]);
  });

  test("after a partial Save, typing a saved field's old value back writes it", () => {
    const submitted = {
      ...opened,
      summary: "Fix login (v2)",
      points: "",
      labels: "",
      epic: "PAY-7",
    };
    const steps = ticketEditSteps(issue, opened, changedValues(opened, submitted, opened));
    const baseline = baselineAfterSave(opened, submitted, steps.slice(0, 1));
    const saved = { ...issue, summary: "Fix login (v2)", storyPoints: null, labels: [] };
    const now = editValues(saved, "");
    const back = { ...submitted, summary: "Fix login", points: "3", labels: "billing" };
    const again = ticketEditSteps(saved, now, changedValues(baseline, back, now));
    expect(again[0]?.action).toEqual({
      kind: "update_fields",
      issueKey: "PAY-12",
      fields: { summary: "Fix login", storyPoints: 3, labels: ["billing"] },
    });
    expect(again[1]?.action.kind).toBe("set_epic");
  });

  test("the team (D59): its id in the fields' PUT, cleared with None, named in the toast", () => {
    const withTeam = { ...issue, team: "Payments", teamId: "12" };
    const start = editValues(withTeam, "");
    expect(start.team).toBe("12");
    const submitted = { ...start, team: "14", labels: "billing q4" };
    const steps = ticketEditSteps(withTeam, start, changedValues(start, submitted, start));
    expect(steps).toEqual([
      {
        parts: ["labels", "team"],
        action: {
          kind: "update_fields",
          issueKey: "PAY-12",
          fields: { labels: ["billing", "q4"], team: "14" },
        },
      },
    ]);
    expect(baselineAfterSave(start, submitted, steps).team).toBe("14");
    expect(ticketEditSteps(withTeam, start, { ...start, team: "" })[0]?.action).toMatchObject({
      fields: { team: null },
    });
    // Another team picked in Jira meanwhile is not written back when untouched.
    const now = editValues({ ...withTeam, teamId: "13" }, "");
    expect(changedValues(start, start, now).team).toBe("13");
  });

  test("a team without an id is shown, never written, and None still clears it", () => {
    const old = { ...issue, team: "Team 12", teamId: null };
    const start = editValues(old, "");
    expect(start.team).toBe(CURRENT_TEAM);
    expect(ticketEditSteps(old, start, start)).toEqual([]);
    expect(ticketEditSteps(old, start, { ...start, team: "" })[0]?.action).toMatchObject({
      fields: { team: null },
    });
    expect(editValues({ ...issue, team: null, teamId: null }, "").team).toBe("");
  });

  test("a sprint move moves the sprint's baseline", () => {
    const submitted = { ...opened, sprint: "41" };
    const [move] = ticketEditSteps(issue, { ...opened, sprint: BACKLOG }, submitted, {
      "41": "PAY 15",
    });
    if (!move) throw new Error("no move");
    expect(baselineAfterSave(opened, submitted, [move]).sprint).toBe("41");
  });

  test("odd cached points or labels never block a Save; changed ones are checked", () => {
    const odd = editValues({ ...issue, storyPoints: 1500, labels: ["x".repeat(300)] }, "");
    expect(editProblems(odd, odd)).toEqual({});
    expect(editProblems(odd, { ...odd, points: "-1" })).toEqual({
      points: "Enter a number from 0 to 1000, or leave it empty",
    });
    expect(editProblems(opened, { ...opened, points: "lots" }).points).toBeDefined();
    expect(editProblems(opened, { ...opened, labels: `ok ${"y".repeat(256)}` })).toEqual({
      labels: "A label holds at most 255 characters",
    });
    expect(editProblems(opened, { ...opened, points: "2", labels: "a b" })).toEqual({});
  });
});

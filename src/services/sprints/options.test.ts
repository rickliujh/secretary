import { describe, expect, test } from "bun:test";
import type { SprintInfo } from "./calendar";
import {
  BACKLOG,
  CURRENT,
  fitSprint,
  joinChecked,
  joinOption,
  joinValue,
  sprintChoices,
  sprintDates,
} from "./options";

const sprint = (s: Partial<SprintInfo> & Pick<SprintInfo, "id" | "name">): SprintInfo => ({
  state: "future",
  boardId: 1,
  start: null,
  end: null,
  ...s,
});

const today = "2026-10-16";
const closed = sprint({
  id: 40,
  name: "PAY 14",
  state: "closed",
  start: "2026-09-28",
  end: "2026-10-09",
});
const active = sprint({
  id: 41,
  name: "PAY 15",
  state: "active",
  start: "2026-10-12",
  end: "2026-10-23",
});
const next = sprint({ id: 43, name: "PAY 17", start: "2026-11-09", end: "2026-11-20" });
const soon = sprint({ id: 42, name: "PAY 16", start: "2026-10-26", end: "2026-11-06" });
const ops = sprint({
  id: 51,
  name: "OPS 8",
  state: "active",
  boardId: 2,
  start: "2026-10-12",
  end: "2026-10-23",
});
const sprints = [closed, next, ops, soon, active];
const boardProjects = { "1": ["PAY"], "2": ["OPS"] };
const base = {
  sprints,
  boardProjects,
  projectKey: "PAY",
  issueType: "Story",
  isSubtask: false,
  current: null as string | null,
  today,
};

const pick = (input: Partial<typeof base> & { current?: string | null }) => {
  const r = sprintChoices({ ...base, ...input });
  if (r.kind !== "pick") throw new Error("no options");
  return r;
};

describe("sprintDates", () => {
  test("names an active sprint's end and a future sprint's start", () => {
    expect(sprintDates(active, today)).toBe("active, ends Fri 23 Oct");
    expect(sprintDates(soon, today)).toBe("starts Mon 26 Oct");
    expect(sprintDates(active, "2026-10-26")).toBe("active, ended Fri 23 Oct");
    expect(sprintDates(closed, today)).toBe("closed");
    expect(sprintDates(sprint({ id: 1, name: "x" }), today)).toBe("future");
  });
});

describe("sprintChoices (D58)", () => {
  test("Backlog, then the project's open sprints: active first, future by start", () => {
    const r = pick({});
    expect(r.options.map((o) => [o.value, o.name, o.when])).toEqual([
      [BACKLOG, "Backlog", ""],
      ["41", "PAY 15", "active, ends Fri 23 Oct"],
      ["42", "PAY 16", "starts Mon 26 Oct"],
      ["43", "PAY 17", "starts Mon 9 Nov"],
    ]);
    // No current sprint: the backlog.
    expect(r.value).toBe(BACKLOG);
  });

  test("with no open sprint on a board showing the project, all open sprints", () => {
    const r = pick({ projectKey: "WEB" });
    expect(r.options.map((o) => o.name)).toEqual([
      "Backlog",
      "OPS 8",
      "PAY 15",
      "PAY 16",
      "PAY 17",
    ]);
  });

  test("the current sprint is matched by name", () => {
    expect(pick({ current: "PAY 16" }).value).toBe("42");
  });

  test("a closed current sprint means the backlog, with a hint naming it", () => {
    const r = pick({ current: "PAY 14" });
    expect(r.value).toBe(BACKLOG);
    expect(r.hint).toBe("Last in PAY 14 (closed)");
    expect(r.current).toBe("PAY 14");
    // No extra option: Backlog stays selected and writes nothing.
    expect(r.options.map((o) => o.value)).toEqual([BACKLOG, "41", "42", "43"]);
  });

  test("two offered sprints of the current name: shown as the current value, both pickable", () => {
    const twin = sprint({ id: 44, name: "PAY 15", start: "2026-10-26", end: "2026-11-06" });
    const r = pick({ sprints: [...sprints, twin], current: "PAY 15" });
    expect(r.value).toBe(CURRENT);
    expect(r.options.at(-1)).toMatchObject({
      value: CURRENT,
      name: "PAY 15",
      when: "one of 2 sprints of this name",
      pickable: false,
    });
    expect(r.options.filter((o) => o.name === "PAY 15" && o.pickable).map((o) => o.value)).toEqual([
      "41",
      "44",
    ]);
    // The active one of that name gets no room line: the load counts the ticket by name.
    expect(fitSprint(r, "41")).toBeNull();
  });

  test("fitSprint: an active sprint the ticket is not in, never a future one or the current", () => {
    const r = pick({ current: "PAY 16" });
    expect(fitSprint(r, "41")?.id).toBe(41);
    expect(fitSprint(r, "42")).toBeNull();
    expect(fitSprint(r, "43")).toBeNull();
    expect(fitSprint(r, BACKLOG)).toBeNull();
    expect(fitSprint(pick({ current: "PAY 15" }), "41")).toBeNull();
    expect(fitSprint(null, "41")).toBeNull();
  });

  test("another board's current sprint says so; an unknown one shows its name", () => {
    expect(pick({ current: "OPS 8" }).options.at(-1)).toMatchObject({
      name: "OPS 8",
      when: "active, ends Fri 23 Oct, its board does not show PAY",
      pickable: false,
    });
    expect(pick({ current: "Old sprint" }).options.at(-1)).toMatchObject({
      name: "Old sprint",
      when: "",
      sprint: null,
    });
  });

  test("Epics and sub-tasks get none", () => {
    expect(sprintChoices({ ...base, issueType: "Epic" })).toEqual({ kind: "none", reason: "epic" });
    expect(sprintChoices({ ...base, issueType: "Sub-task", isSubtask: true })).toEqual({
      kind: "none",
      reason: "subtask",
    });
  });

  test("a sprint listed twice is offered once", () => {
    expect(pick({ sprints: [active, active] }).options.map((o) => o.value)).toEqual([
      BACKLOG,
      "41",
    ]);
  });
});

describe("the sprint switch and the Sprint select (D58)", () => {
  test("the switch's sprint is offered only when the select lists it", () => {
    const r = pick({});
    expect(joinOption(r, 41)?.value).toBe("41");
    // OPS 8's board does not show PAY, so the select does not list it.
    expect(joinOption(r, 51)).toBeNull();
    expect(joinOption(r, null)).toBeNull();
    expect(joinOption(sprintChoices({ ...base, issueType: "Epic" }), 41)).toBeNull();
    expect(joinOption(null, 41)).toBeNull();
  });

  test("one value: on picks the sprint, off picks Backlog, another sprint turns it off", () => {
    const r = pick({});
    const option = joinOption(r, 41);
    if (!option) throw new Error("no option");
    expect(joinChecked(option, r.value)).toBe(false);
    expect(joinValue(option, true)).toBe("41");
    expect(joinChecked(option, "41")).toBe(true);
    expect(joinValue(option, false)).toBe(BACKLOG);
    expect(joinChecked(option, "42")).toBe(false);
    // Off gives back what the select held before on, else the opened sprint;
    // Backlog only for a ticket that was in the switch's sprint (review).
    expect(joinValue(option, false, { before: "43", opened: "42" })).toBe("43");
    expect(joinValue(option, false, { before: null, opened: "42" })).toBe("42");
    expect(joinValue(option, false, { before: "41", opened: "41" })).toBe(BACKLOG);
    expect(joinValue(option, false, { before: null, opened: CURRENT })).toBe(CURRENT);
    // A ticket already in the sprint starts on, with no room line.
    const inIt = pick({ current: "PAY 15" });
    expect(joinChecked(option, inIt.value)).toBe(true);
    expect(fitSprint(inIt, inIt.value)).toBeNull();
  });
});

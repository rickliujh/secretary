/** joinSprint on creates (FR-16.1, D57): code's default, kept when the user chose it. */
import { describe, expect, test } from "bun:test";
import { snapshot } from "@/test/fixtures/intake/snapshot";
import {
  buildClassifyPrompt,
  CLASSIFY_PROMPT_VERSION,
  type ItemOutput,
  type ItemSnapshot,
  mapItemOutput,
  type SmallAskHomeSnapshot,
} from "./classify";

const sprinted: ItemSnapshot = {
  ...snapshot,
  // The user's active sprints, most work first: OPS's board, then PAY's.
  userSprints: [
    { name: "Ops 8", end: "2026-09-30", projects: ["OPS"] },
    { name: "Payments 8", end: "2026-10-05", projects: ["PAY"] },
  ],
};
const e = { rationale: "r", evidence: "e", confidence: 0.9 };
const answer = (...proposals: Record<string, unknown>[]): ItemOutput => ({
  summary: "s",
  question: null,
  confidence: 0.9,
  proposals: proposals as ItemOutput["proposals"],
});
const create = (o: Record<string, unknown> = {}) => ({
  kind: "create_issue",
  ref: "$new:1",
  projectKey: "PAY",
  issueType: "Story",
  summary: "Export credit notes to the ledger",
  ...e,
  ...o,
});
const mapped = (s: ItemSnapshot, ...proposals: Record<string, unknown>[]) =>
  mapItemOutput(answer(...proposals), s.quote, s).map((m) => m.payload);
const sprintOf = (p: unknown) => {
  const { joinSprint, joinSprintChosen } = p as { joinSprint: boolean; joinSprintChosen: boolean };
  return { joinSprint, joinSprintChosen };
};

describe("joinSprint defaults", () => {
  test("due on or before the end of the sprint it would join: on", () => {
    // PAY's board sprint ends 2026-10-05, though Ops 8 holds more of the user's work.
    const [p] = mapped(sprinted, create({ dueDate: "2026-10-05" }));
    expect(sprintOf(p)).toEqual({ joinSprint: true, joinSprintChosen: false });
  });

  test("due after the end, or no due date: off", () => {
    const [late, none] = mapped(
      sprinted,
      create({ dueDate: "2026-10-06" }),
      create({ ref: "$new:2", summary: "Another" }),
    );
    expect(sprintOf(late).joinSprint).toBe(false);
    expect(sprintOf(none).joinSprint).toBe(false);
  });

  test("a project no board of the user's shows: the first sprint's end decides", () => {
    const s = {
      ...sprinted,
      projects: [...sprinted.projects, { key: "WEB", issueTypes: ["Story"], statuses: [] }],
    };
    const [early, late] = mapped(
      s,
      create({ projectKey: "WEB", dueDate: "2026-09-30" }),
      create({ ref: "$new:2", projectKey: "WEB", dueDate: "2026-10-01" }),
    );
    expect(sprintOf(early).joinSprint).toBe(true);
    expect(sprintOf(late).joinSprint).toBe(false);
  });

  test("Epics and sub-tasks never join", () => {
    const [epic, sub] = mapped(
      sprinted,
      create({ issueType: "Epic", dueDate: "2026-09-25" }),
      create({ ref: "$new:2", issueType: "Sub-task", parent: "PAY-2", dueDate: "2026-09-25" }),
    );
    expect(sprintOf(epic).joinSprint).toBe(false);
    expect(sprintOf(sub).joinSprint).toBe(false);
  });

  test("no active sprint of the user's, or an older snapshot: off", () => {
    const [p] = mapped({ ...sprinted, userSprints: [] }, create({ dueDate: "2026-09-25" }));
    expect(sprintOf(p).joinSprint).toBe(false);
    const [q] = mapped(snapshot, create({ dueDate: "2026-09-25" }));
    expect(sprintOf(q).joinSprint).toBe(false);
  });

  test("a small ask follows Settings, whatever its due date", () => {
    const home: SmallAskHomeSnapshot = {
      projectKey: "OPS",
      label: "small-ask",
      joinSprint: true,
      issueTypes: ["Task"],
      defaultType: "Task",
    };
    const ask = create({ smallAsk: "yes", issueType: null, dueDate: "2027-01-01" });
    const [on] = mapped({ ...sprinted, smallAsks: home }, ask);
    expect(sprintOf(on)).toEqual({ joinSprint: true, joinSprintChosen: false });
    const [off] = mapped({ ...sprinted, smallAsks: { ...home, joinSprint: false } }, ask);
    expect(sprintOf(off).joinSprint).toBe(false);
  });
});

describe("a chosen value survives a revision and re-triage", () => {
  const revising = (choices: Record<string, boolean>): ItemSnapshot => ({
    ...sprinted,
    thread: {
      instructions: ["make the summary shorter"],
      decided: [],
      pending: [create({ dueDate: "2026-10-05" })],
      sprintChoices: choices,
    },
  });

  test("switched off: stays off although the due date would join", () => {
    const [p] = mapped(revising({ "$new:1": false }), create({ dueDate: "2026-10-05" }));
    expect(sprintOf(p)).toEqual({ joinSprint: false, joinSprintChosen: true });
  });

  test("switched on: stays on although there is no due date", () => {
    const [p] = mapped(revising({ "$new:1": true }), create());
    expect(sprintOf(p)).toEqual({ joinSprint: true, joinSprintChosen: true });
  });

  test("unchosen: recomputed from the revised due date", () => {
    const [p] = mapped(revising({}), create({ dueDate: "2026-12-01" }));
    expect(sprintOf(p)).toEqual({ joinSprint: false, joinSprintChosen: false });
  });

  test("a small ask keeps the choice over the Settings default", () => {
    const home: SmallAskHomeSnapshot = {
      projectKey: "OPS",
      label: "small-ask",
      joinSprint: true,
      issueTypes: ["Task"],
      defaultType: "Task",
    };
    const s = { ...revising({ "$new:1": false }), smallAsks: home };
    const [p] = mapped(s, create({ smallAsk: "yes", issueType: null }));
    expect(sprintOf(p)).toEqual({ joinSprint: false, joinSprintChosen: true });
  });

  test("an Epic never joins, even when chosen", () => {
    const [p] = mapped(revising({ "$new:1": true }), create({ issueType: "Epic" }));
    expect(sprintOf(p).joinSprint).toBe(false);
  });
});

describe("the model is not asked", () => {
  test("the prompt and its version do not change", () => {
    const s = {
      ...sprinted,
      thread: {
        instructions: ["x"],
        decided: [],
        pending: [create()],
        sprintChoices: { "$new:1": true },
      },
    };
    const plain = {
      ...s,
      userSprints: undefined,
      thread: { ...s.thread, sprintChoices: undefined },
    };
    expect(buildClassifyPrompt(s)).toEqual(buildClassifyPrompt(plain));
    expect(JSON.stringify(buildClassifyPrompt(s))).not.toContain("joinSprint");
    expect(CLASSIFY_PROMPT_VERSION).toBeGreaterThanOrEqual(12);
  });
});

/** Small asks in classify_item (D44): the field, the rule, and what code decides. */
import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import { snapshot } from "@/test/fixtures/intake/snapshot";
import {
  buildClassifyPrompt,
  buildItemSchema,
  fromPayload,
  type ItemOutput,
  type ItemSnapshot,
  mapItemOutput,
  type SmallAskHomeSnapshot,
  validateItemOutput,
} from "./classify";

const homeOps: SmallAskHomeSnapshot = {
  projectKey: "OPS",
  label: "small-ask",
  joinSprint: true,
  issueTypes: ["Task"],
  defaultType: "Task",
};
const home: ItemSnapshot = {
  ...snapshot,
  quote: "Can you send me the Q3 numbers by Friday?",
  smallAsks: homeOps,
};
const e = { rationale: "r", evidence: "send me the Q3 numbers", confidence: 0.9 };
const ask = {
  kind: "create_issue",
  ref: "$new:1",
  smallAsk: "yes",
  summary: "Send Ana the Q3 numbers",
  description: "Pull the Q3 totals from the ledger.",
  dueDate: "2026-09-25",
  // The model may fill these; code decides them for a small ask.
  projectKey: "PAY",
  assignee: "ana.b",
  issueType: null,
  ...e,
};
const answer = (...proposals: Record<string, unknown>[]): ItemOutput => ({
  summary: "s",
  question: null,
  confidence: 0.9,
  proposals: proposals as ItemOutput["proposals"],
});

describe("small asks in the schema", () => {
  test("without a home the schema and the prompt are as before", () => {
    const shape = buildItemSchema(snapshot).shape.proposals.element.shape;
    expect(shape).not.toHaveProperty("smallAsk");
    expect(shape).not.toHaveProperty("requesterPersonId");
    const { system, prompt } = buildClassifyPrompt(snapshot);
    expect(system).not.toContain("small ask");
    expect(prompt).not.toContain("Small-asks home");
  });

  test("with a home: a yes/no field, a requester from the contacts, the rule and the types", () => {
    const shape = buildItemSchema(home).shape.proposals.element.shape as unknown as Record<
      string,
      z.ZodType
    >;
    const { smallAsk, requesterPersonId } = shape;
    if (!smallAsk || !requesterPersonId) throw new Error("fields missing");
    expect(smallAsk.parse("yes")).toBe("yes");
    expect(smallAsk.safeParse("maybe").success).toBe(false);
    expect(requesterPersonId.parse("p-tom")).toBe("p-tom");
    expect(requesterPersonId.safeParse("p-nobody").success).toBe(false);
    const { system, prompt } = buildClassifyPrompt(home);
    expect(system).toContain("propose create_issue with smallAsk yes");
    expect(system).toContain("make it a Sub-task of that issue");
    expect(prompt).toContain("Small-asks home: project OPS; issue types Task; default Task");
  });
});

describe("mapping a small ask (code sets the home)", () => {
  test("project, label, assignee, sprint, type, requester and provenance come from code", () => {
    const out = answer(ask);
    expect(validateItemOutput(out, home)).toEqual([]);
    const [m] = mapItemOutput(out, home.quote, home);
    expect(m?.payload).toEqual({
      kind: "create_issue",
      ref: "$new:1",
      projectKey: "OPS",
      issueType: "Task",
      summary: "Send Ana the Q3 numbers",
      descriptionMd:
        "Pull the Q3 totals from the ledger.\n\n_Asked by Ana Bell via Teams on 2026-09-24:_\n\n> Can you send me the Q3 numbers by Friday?",
      parent: null,
      epic: null,
      priority: null,
      assignee: "rliu",
      dueDate: "2026-09-25",
      labels: ["small-ask"],
      smallAsk: true,
      // The sender asked.
      requesterPersonId: "p-ana",
      joinSprint: true,
      joinSprintChosen: false,
      storyPoints: null,
      storyPointsEstimated: false,
      storyPointsCleared: false,
    });
  });

  test("with no sender, the requester is the contact the model picked", () => {
    const s = { ...home, sender: null, source: "typed" };
    const [m] = mapItemOutput(answer({ ...ask, requesterPersonId: "p-tom" }), s.quote, s);
    expect(m?.payload).toMatchObject({ requesterPersonId: "p-tom" });
    expect(m?.payload.kind === "create_issue" && m.payload.descriptionMd).toContain(
      "_Asked by Tom Kay via a note on 2026-09-24:_",
    );
    const [none] = mapItemOutput(answer(ask), s.quote, s);
    expect(none?.payload).toMatchObject({ requesterPersonId: null });
  });

  test("an ask under a candidate story is a sub-task in the story's project, not in a sprint", () => {
    const sub = { ...ask, issueType: "Sub-task", parent: "PAY-2", epic: null };
    expect(validateItemOutput(answer(sub), home)).toEqual([]);
    const [m] = mapItemOutput(answer(sub), home.quote, home);
    expect(m?.payload).toMatchObject({
      projectKey: "PAY",
      issueType: "Sub-task",
      parent: "PAY-2",
      joinSprint: false,
      joinSprintChosen: false,
      labels: ["small-ask"],
      smallAsk: true,
    });
  });

  test("Jira's sub-task flag decides which type is a sub-task, not its name", () => {
    // PAY calls its sub-task type "Action"; flags were stored at sync.
    const s: ItemSnapshot = {
      ...home,
      projects: home.projects.map((p) =>
        p.key === "PAY"
          ? { ...p, issueTypes: ["Epic", "Story", "Task", "Action"], subtaskTypes: ["Action"] }
          : { ...p, subtaskTypes: ["Sub-task"] },
      ),
    };
    const sub = { ...ask, issueType: "Action", parent: "PAY-2", epic: null };
    expect(validateItemOutput(answer(sub), s)).toEqual([]);
    const [m] = mapItemOutput(answer(sub), s.quote, s);
    expect(m?.payload).toMatchObject({
      projectKey: "PAY",
      issueType: "Action",
      parent: "PAY-2",
      joinSprint: false,
      joinSprintChosen: false,
    });
  });

  test("planned work is smallAsk no and keeps the model's project and type", () => {
    const planned = {
      ...ask,
      smallAsk: "no",
      projectKey: "PAY",
      issueType: "Story",
      assignee: null,
      epic: "PAY-1",
    };
    expect(validateItemOutput(answer(planned), home)).toEqual([]);
    const [m] = mapItemOutput(answer(planned), home.quote, home);
    expect(m?.payload).toMatchObject({
      projectKey: "PAY",
      issueType: "Story",
      labels: [],
      smallAsk: false,
      joinSprint: false,
      joinSprintChosen: false,
      descriptionMd: "Pull the Q3 totals from the ledger.",
    });
  });

  test("a revision sees the model's own description and maps back to the same payload", () => {
    const [m] = mapItemOutput(answer(ask), home.quote, home);
    if (!m) throw new Error("no proposal");
    const shape = fromPayload(m.payload);
    expect(shape).toMatchObject({
      smallAsk: "yes",
      requesterPersonId: "p-ana",
      description: "Pull the Q3 totals from the ledger.",
    });
    const [again] = mapItemOutput(answer({ ...shape, ...e }), home.quote, home);
    expect(again?.payload).toEqual(m.payload);
  });
});

describe("validating small asks", () => {
  const errorsOf = (p: Record<string, unknown>) => validateItemOutput(answer(p), home);

  test("with a home every create says whether it is a small ask", () => {
    expect(errorsOf({ ...ask, smallAsk: null })).toContain(
      "Proposal 1 (create_issue): set smallAsk to yes or no.",
    );
    // smallAsk no needs a project and type, as before.
    expect(errorsOf({ ...ask, smallAsk: "no", projectKey: null })).toContain(
      "Proposal 1 (create_issue): create_issue needs projectKey, issueType.",
    );
  });

  test("types: no epics, only the home's types, sub-tasks only under a candidate story", () => {
    expect(errorsOf({ ...ask, issueType: "Epic" })).toContain(
      "Proposal 1 (create_issue): a small ask cannot be an Epic.",
    );
    expect(errorsOf({ ...ask, issueType: "Bug" })).toContain(
      "Proposal 1 (create_issue): a small ask in OPS can be Task, not Bug.",
    );
    const underEpic = errorsOf({ ...ask, issueType: "Sub-task", parent: null });
    expect(underEpic.join(" ")).toContain("Sub-task only under an existing candidate story");
    expect(errorsOf({ ...ask, parent: "PAY-2" })).toContain(
      "Proposal 1 (create_issue): only a Sub-task has a parent; use epic for epics.",
    );
    expect(errorsOf({ ...ask, epic: "PAY-2" })).toContain(
      "Proposal 1 (create_issue): epic PAY-2 is not an Epic.",
    );
  });

  test("before Jira's metadata is synced any non-epic type is accepted", () => {
    const s = {
      ...home,
      smallAsks: { ...homeOps, issueTypes: [], defaultType: null },
    };
    expect(validateItemOutput(answer({ ...ask, issueType: "Story" }), s)).toEqual([]);
    const [m] = mapItemOutput(answer(ask), s.quote, s);
    expect(m?.payload).toMatchObject({ issueType: "Task" });
  });
});

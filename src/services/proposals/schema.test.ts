import { describe, expect, test } from "bun:test";
import {
  CreateIssue,
  describeCorrection,
  describePayload,
  describeStoredPayload,
  effectivePayload,
  issueRefs,
  MoveToSprint,
  PROPOSAL_LABELS,
  ProposalPayloadSchema,
  parsePayload,
  payloadChanges,
  resolveRefs,
  UpdateIssue,
} from "./schema";

describe("proposal payloads", () => {
  test("defaults fill optional fields", () => {
    const p = ProposalPayloadSchema.parse({
      kind: "create_issue",
      ref: "$new:1",
      projectKey: "PAY",
      issueType: "Task",
      summary: "Chase ledger",
    });
    expect(p).toMatchObject({ parent: null, epic: null, descriptionMd: null });
  });

  test("updates need at least one change and valid refs", () => {
    expect(
      ProposalPayloadSchema.safeParse({ kind: "update_issue", target: "PAY-2", changes: {} })
        .success,
    ).toBe(false);
    expect(
      ProposalPayloadSchema.safeParse({ kind: "add_comment", target: "pay-2", bodyMd: "x" })
        .success,
    ).toBe(false);
    expect(
      ProposalPayloadSchema.safeParse({ kind: "add_comment", target: "$new:2", bodyMd: "x" })
        .success,
    ).toBe(true);
  });

  test("resolveRefs swaps placeholders for created keys everywhere", () => {
    const created = new Map([["$new:1", "PAY-10"]]);
    const sub = ProposalPayloadSchema.parse({
      kind: "create_issue",
      ref: "$new:2",
      projectKey: "PAY",
      issueType: "Sub-task",
      summary: "s",
      parent: "$new:1",
    });
    expect(resolveRefs(sub, created)).toMatchObject({ parent: "PAY-10" });
    const draft = ProposalPayloadSchema.parse({
      kind: "draft_message",
      channel: "teams",
      intent: "chase",
      issueKeys: ["$new:1", "PAY-2"],
    });
    expect(resolveRefs(draft, created)).toMatchObject({ issueKeys: ["PAY-10", "PAY-2"] });
    expect(issueRefs(sub)).toEqual(["$new:1"]);
  });

  test("issueRefs filters new refs and real keys", () => {
    const create = CreateIssue.parse({
      kind: "create_issue",
      ref: "$new:2",
      projectKey: "PAY",
      issueType: "Sub-task",
      summary: "s",
      parent: "$new:1",
      epic: "PAY-1",
    });
    expect(issueRefs(create)).toEqual(["$new:1", "PAY-1"]);
    expect(issueRefs(create, { only: "new" })).toEqual(["$new:1"]);
    expect(issueRefs(create, { only: "new", includeOwn: true })).toEqual(["$new:2", "$new:1"]);
    expect(issueRefs(create, { only: "keys" })).toEqual(["PAY-1"]);
    const draft = ProposalPayloadSchema.parse({
      kind: "draft_message",
      channel: "email",
      intent: "chase",
      issueKeys: ["$new:1", "PAY-2"],
    });
    expect(issueRefs(draft, { only: "keys" })).toEqual(["PAY-2"]);
  });

  test("payloadChanges names every field a correction changed", () => {
    const before = CreateIssue.parse({
      kind: "create_issue",
      ref: "$new:1",
      projectKey: "PAY",
      issueType: "Bug",
      summary: "Receipt date",
      assignee: null,
    });
    expect(payloadChanges(before, { ...before, ref: "$new:2", assignee: "ana.b" })).toEqual([
      "assignee: (none) -> ana.b",
    ]);
    const update = UpdateIssue.parse({
      kind: "update_issue",
      target: "PAY-4",
      changes: { priority: "Medium" },
    });
    expect(
      payloadChanges(update, {
        ...update,
        changes: { priority: "High", dueDate: "2026-10-02" },
      }),
    ).toEqual(["priority: Medium -> High", "dueDate: (none) -> 2026-10-02"]);
  });

  test("stored corrections are described with what changed", () => {
    const before = { kind: "transition_issue", target: "PAY-2", toStatus: "Done" };
    const after = { ...before, toStatus: "To Do" };
    expect(describeStoredPayload(before)).toBe("Move PAY-2 to Done");
    expect(describeStoredPayload([before, after])).toBe("Move PAY-2 to Done; Move PAY-2 to To Do");
    expect(describeStoredPayload([])).toBe("nothing");
    expect(describeStoredPayload({ kind: "gone" })).toBe('{"kind":"gone"}');
    expect(describeCorrection(before, after)).toBe(
      "Move PAY-2 to To Do (changed toStatus: Done -> To Do)",
    );
    expect(describeCorrection(before, before)).toBe("Move PAY-2 to Done");
  });
});

describe("move_to_sprint (D30)", () => {
  const move = { kind: "move_to_sprint", target: "PAY-4", sprintId: 44, sprintName: "Payments 16" };

  test("needs a real issue key, a positive integer sprint id and a name", () => {
    expect(ProposalPayloadSchema.parse(move)).toEqual(MoveToSprint.parse(move));
    const bad = [
      { ...move, target: "$new:1" },
      { ...move, target: "pay-4" },
      { ...move, sprintId: 0 },
      { ...move, sprintId: 4.5 },
      { ...move, sprintId: "44" },
      { ...move, sprintName: " " },
      { kind: "move_to_sprint", target: "PAY-4", sprintId: 44 },
    ];
    for (const p of bad) expect(ProposalPayloadSchema.safeParse(p).success).toBe(false);
  });

  test("is labelled and described for cards, and points at its issue", () => {
    const p = ProposalPayloadSchema.parse(move);
    expect(PROPOSAL_LABELS.move_to_sprint).toBe("Move to sprint");
    expect(describePayload(p)).toBe("Move PAY-4 to sprint Payments 16");
    expect(issueRefs(p)).toEqual(["PAY-4"]);
    expect(issueRefs(p, { only: "new" })).toEqual([]);
    expect(resolveRefs(p, new Map([["$new:1", "PAY-9"]]))).toEqual(p);
  });
});

describe("story points (D55)", () => {
  const create = {
    kind: "create_issue" as const,
    ref: "$new:1",
    projectKey: "PAY",
    issueType: "Story",
    summary: "Export credit notes",
  };

  test("describePayload shows the points, marked while suggested", () => {
    const p = (extra: object) => ProposalPayloadSchema.parse({ ...create, ...extra });
    expect(describePayload(p({}))).toBe("Create Story in PAY: Export credit notes");
    expect(describePayload(p({ storyPoints: 3 }))).toBe(
      "Create Story in PAY: Export credit notes, 3 points",
    );
    expect(describePayload(p({ storyPoints: 5, storyPointsEstimated: true }))).toBe(
      "Create Story in PAY: Export credit notes, 5 points (suggested)",
    );
    expect(describePayload(p({ storyPoints: 1 }))).toBe(
      "Create Story in PAY: Export credit notes, 1 point",
    );
    const update = (changes: object) =>
      describePayload(
        ProposalPayloadSchema.parse({ kind: "update_issue", target: "PAY-12", changes }),
      );
    expect(update({ storyPoints: 5 })).toBe("Update PAY-12: 5 points");
    expect(update({ summary: "x", storyPoints: null })).toBe(
      "Update PAY-12: summary, clear story points",
    );
  });

  test("points are a number from 0 to 1000; a stored create without them reads as none", () => {
    expect(ProposalPayloadSchema.safeParse({ ...create, storyPoints: -1 }).success).toBe(false);
    expect(ProposalPayloadSchema.safeParse({ ...create, storyPoints: 1001 }).success).toBe(false);
    expect(ProposalPayloadSchema.safeParse({ ...create, storyPoints: "3" }).success).toBe(false);
    expect(parsePayload(create)).toMatchObject({ storyPoints: null, storyPointsEstimated: false });
  });
});

describe("parsePayload", () => {
  test("a create_issue stored before small asks gets the new fields' defaults (D44)", () => {
    const stored = {
      kind: "create_issue" as const,
      ref: "$new:1",
      projectKey: "PAY",
      issueType: "Task",
      summary: "Old",
    };
    expect(parsePayload(stored)).toEqual({
      ...stored,
      descriptionMd: null,
      parent: null,
      epic: null,
      priority: null,
      assignee: null,
      dueDate: null,
      labels: [],
      smallAsk: false,
      requesterPersonId: null,
      joinSprint: false,
      storyPoints: null,
      storyPointsEstimated: false,
      storyPointsCleared: false,
    });
    expect(effectivePayload({ payload: stored, editedPayload: null })).toMatchObject({
      labels: [],
    });
  });

  test("a value that no longer parses is returned as it is", () => {
    const broken = { kind: "create_issue", summary: "" };
    expect(parsePayload(broken)).toBe(broken as never);
  });
});

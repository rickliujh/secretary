import { describe, expect, test } from "bun:test";
import { issueRefs, ProposalPayloadSchema, resolveRefs } from "./schema";

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
});

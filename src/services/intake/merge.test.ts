import { describe, expect, test } from "bun:test";
import type { MappedProposal } from "@/prompts/classify";
import { ProposalPayloadSchema } from "@/services/proposals/schema";
import { mergeItemProposals } from "./merge";

const m = (payload: Record<string, unknown>, confidence = 0.8): MappedProposal => ({
  payload: ProposalPayloadSchema.parse(payload),
  rationale: "r",
  evidence: "e",
  confidence,
});

describe("mergeItemProposals", () => {
  test("renumbers $new refs per item into one namespace and rewrites references", () => {
    const merged = mergeItemProposals([
      [
        m({
          kind: "create_issue",
          ref: "$new:1",
          projectKey: "PAY",
          issueType: "Story",
          summary: "Export refunds",
        }),
      ],
      [
        m({
          kind: "create_issue",
          ref: "$new:1",
          projectKey: "OPS",
          issueType: "Task",
          summary: "Open port",
        }),
        m({ kind: "add_comment", target: "$new:1", bodyMd: "context" }),
      ],
    ]);
    expect(merged.map((x) => x.payload)).toMatchObject([
      { kind: "create_issue", ref: "$new:1", summary: "Export refunds" },
      { kind: "create_issue", ref: "$new:2", summary: "Open port" },
      { kind: "add_comment", target: "$new:2" },
    ]);
    expect(merged.map((x) => x.itemIndex)).toEqual([0, 1, 1]);
  });

  test("the same new issue in two items is created once and both items point at it", () => {
    const merged = mergeItemProposals([
      [
        m({
          kind: "create_issue",
          ref: "$new:1",
          projectKey: "PAY",
          issueType: "Task",
          summary: "Chase ledger fix",
        }),
      ],
      [
        m({
          kind: "create_issue",
          ref: "$new:1",
          projectKey: "PAY",
          issueType: "Task",
          summary: "Chase ledger fix!",
        }),
        m({ kind: "add_comment", target: "$new:1", bodyMd: "from item 2" }),
      ],
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[1]?.payload).toMatchObject({ kind: "add_comment", target: "$new:1" });
  });

  test("exact duplicates are dropped, keeping the more confident rationale; creates come first", () => {
    const merged = mergeItemProposals([
      [m({ kind: "transition_issue", target: "PAY-2", toStatus: "Blocked" }, 0.6)],
      [
        m({ kind: "transition_issue", target: "PAY-2", toStatus: "Blocked" }, 0.9),
        m({
          kind: "create_issue",
          ref: "$new:1",
          projectKey: "PAY",
          issueType: "Task",
          summary: "x",
        }),
      ],
    ]);
    expect(merged.map((x) => x.payload.kind)).toEqual(["create_issue", "transition_issue"]);
    expect(merged[1]?.confidence).toBe(0.9);
  });
});

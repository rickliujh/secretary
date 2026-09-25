import { describe, expect, test } from "bun:test";
import type { ProposalPayload } from "@/services/proposals/schema";
import { partsOf, splitMessage, withLinkedItems } from "./thread";

describe("splitMessage", () => {
  test("pasted text is input and typed text instructs it", () => {
    expect(
      splitMessage(
        [
          { type: "pasted", text: "Bob: the rounding bug hits customers" },
          { type: "typed", text: "bump PAY-4, due Friday" },
        ],
        true,
      ),
    ).toEqual({
      input: "Bob: the rounding bug hits customers",
      instruction: "bump PAY-4, due Friday",
    });
  });

  test("typed text alone is the input of a new thread and the instruction of a reply", () => {
    const parts = partsOf("Comment on PAY-4 that it ships Thursday", null, true);
    expect(splitMessage(parts, true)).toEqual({
      input: "Comment on PAY-4 that it ships Thursday",
      instruction: null,
    });
    expect(splitMessage(parts, false)).toEqual({
      input: "",
      instruction: "Comment on PAY-4 that it ships Thursday",
    });
  });
});

describe("withLinkedItems", () => {
  const create = (ref: string): ProposalPayload => ({
    kind: "create_issue",
    ref,
    projectKey: "PAY",
    issueType: "Task",
    summary: "x",
    descriptionMd: null,
    parent: null,
    epic: null,
    priority: null,
    assignee: null,
    dueDate: null,
  });
  const comment = (target: string): ProposalPayload => ({
    kind: "add_comment",
    target,
    bodyMd: "y",
  });

  test("adds items that share a $new ref with a chosen item, transitively", () => {
    const pending = new Map<number, ProposalPayload[]>([
      [0, [create("$new:1")]],
      [1, [comment("$new:1"), create("$new:2")]],
      [2, [comment("$new:2")]],
      [3, [comment("PAY-4")]],
    ]);
    expect(withLinkedItems([2], pending)).toEqual([0, 1, 2]);
    expect(withLinkedItems([3], pending)).toEqual([3]);
  });
});

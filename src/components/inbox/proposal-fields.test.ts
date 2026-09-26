import { describe, expect, test } from "bun:test";
import { ProposalPayloadSchema } from "@/services/proposals/schema";
import { fromFormValues, isEditable, toFormValues } from "./proposal-fields";

describe("proposal edit form values", () => {
  test("round trip keeps unchanged payloads identical", () => {
    const p = ProposalPayloadSchema.parse({
      kind: "link_dependency",
      target: "PAY-2",
      dependencyKind: "incident",
      label: "Platform",
      externalRef: "INC0012345",
    });
    expect(ProposalPayloadSchema.parse(fromFormValues(p, toFormValues(p)))).toEqual(p);
  });

  test("empty change fields mean no change; lists split on commas", () => {
    const p = ProposalPayloadSchema.parse({
      kind: "update_issue",
      target: "PAY-2",
      changes: { summary: "Old", priority: "High" },
    });
    const values = { ...toFormValues(p), changes__priority: "" };
    expect(fromFormValues(p, values)).toEqual({
      kind: "update_issue",
      target: "PAY-2",
      changes: { summary: "Old" },
    });
    const d = ProposalPayloadSchema.parse({
      kind: "draft_message",
      channel: "teams",
      intent: "chase",
      issueKeys: ["PAY-2"],
    });
    expect(
      (
        fromFormValues(d, { ...toFormValues(d), issueKeys: "PAY-2, OPS-7" }) as {
          issueKeys: string[];
        }
      ).issueKeys,
    ).toEqual(["PAY-2", "OPS-7"]);
  });

  test("clearing profile fields drops the profile change", () => {
    const p = ProposalPayloadSchema.parse({
      kind: "update_person",
      personId: "p1",
      changes: { profile: { formality: "formal" } },
    });
    const cleared = fromFormValues(p, { ...toFormValues(p), changes__profile__formality: "" }) as {
      changes: object;
    };
    expect(cleared.changes).toEqual({});
  });
});

describe("kinds without an edit form", () => {
  test("a sprint move is approved as it is: no fields, payload unchanged", () => {
    const p = ProposalPayloadSchema.parse({
      kind: "move_to_sprint",
      target: "PAY-4",
      sprintId: 44,
      sprintName: "Payments 16",
    });
    expect(isEditable(p)).toBe(false);
    expect(toFormValues(p)).toEqual({});
    expect(fromFormValues(p, { target: "PAY-9" })).toEqual(p);
    expect(
      isEditable(ProposalPayloadSchema.parse({ kind: "needs_clarification", question: "?" })),
    ).toBe(false);
    expect(
      isEditable(
        ProposalPayloadSchema.parse({ kind: "add_comment", target: "PAY-2", bodyMd: "x" }),
      ),
    ).toBe(true);
  });
});

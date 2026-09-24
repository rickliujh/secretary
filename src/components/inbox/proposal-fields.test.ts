import { describe, expect, test } from "bun:test";
import { ProposalPayloadSchema } from "@/services/proposals/schema";
import { fromFormValues, toFormValues } from "./proposal-fields";

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

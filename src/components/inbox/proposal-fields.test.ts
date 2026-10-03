import { describe, expect, test } from "bun:test";
import { ProposalPayloadSchema, parsePayload } from "@/services/proposals/schema";
import {
  fromFormValues,
  isEditable,
  issueOptions,
  toFormValues,
  viewPayload,
} from "./proposal-fields";

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

describe("issueOptions", () => {
  const t = (key: string, p: Partial<Parameters<typeof issueOptions>[0][number]> = {}) => ({
    key,
    summary: key,
    issueType: "Story",
    isSubtask: false,
    projectKey: key.split("-")[0] ?? "",
    epicKey: null,
    statusCategory: "indeterminate" as const,
    stale: false,
    ...p,
  });
  const tickets = [
    t("PAY-1", { issueType: "Epic", summary: "Billing" }),
    t("OPS-3", { issueType: "Initiative", summary: "Infra" }),
    t("OPS-4", { epicKey: "OPS-3" }),
    t("PAY-9", { issueType: "Epic", statusCategory: "done" }),
    t("PAY-2", { epicKey: "PAY-1" }),
    t("PAY-3", { issueType: "Sub-task", isSubtask: true }),
    t("PAY-8", { issueType: "Epic", stale: true }),
  ];

  test("epics by type or by having children; open ones and the chosen project first", () => {
    expect(issueOptions(tickets, "epic", "PAY").map((o) => o.value)).toEqual([
      "PAY-1",
      "OPS-3",
      "PAY-9",
    ]);
  });

  test("parents exclude epics and sub-tasks; any means every synced ticket", () => {
    expect(issueOptions(tickets, "parent").map((o) => o.value)).toEqual(["OPS-4", "PAY-2"]);
    expect(issueOptions(tickets, "any")).toHaveLength(6);
  });
});

describe("viewPayload (stored payloads that no longer parse)", () => {
  test("missing arrays and nested objects read as empty", () => {
    // A lower-case project key keeps it from parsing, so no defaults are filled in.
    const create = parsePayload({
      kind: "create_issue",
      ref: "$new:1",
      projectKey: "ops",
      issueType: "Task",
      summary: "Old proposal",
    });
    expect("labels" in create).toBe(false);
    expect(viewPayload(create)).toMatchObject({ summary: "Old proposal", labels: [] });
    expect(viewPayload(parsePayload({ kind: "update_issue", target: "PAY-1" }))).toMatchObject({
      changes: {},
    });
    expect(
      viewPayload(parsePayload({ kind: "draft_message", channel: "teams", intent: "nope" })),
    ).toMatchObject({ issueKeys: [] });
    // A payload that parses is unchanged.
    const ok = ProposalPayloadSchema.parse({ kind: "add_comment", target: "PAY-1", bodyMd: "x" });
    expect(viewPayload(ok)).toBe(ok);
  });
});

describe("link_issues edit form (D45)", () => {
  test("target and blocker round trip, and a changed blocker parses", () => {
    const p = ProposalPayloadSchema.parse({
      kind: "link_issues",
      target: "$new:1",
      blocker: "PLAT-1",
    });
    expect(isEditable(p)).toBe(true);
    const values = toFormValues(p);
    expect(values).toEqual({ target: "$new:1", blocker: "PLAT-1" });
    expect(ProposalPayloadSchema.parse(fromFormValues(p, values))).toEqual(p);
    const edited = fromFormValues(p, { ...values, blocker: "PAY-2" });
    expect(ProposalPayloadSchema.parse(edited)).toMatchObject({ blocker: "PAY-2" });
    // The same issue on both ends does not parse.
    expect(
      ProposalPayloadSchema.safeParse(fromFormValues(p, { ...values, blocker: "$new:1" })).success,
    ).toBe(false);
  });
});

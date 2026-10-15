import { describe, expect, test } from "bun:test";
import { ProposalPayloadSchema, parsePayload } from "@/services/proposals/schema";
import {
  FIELD_SPECS,
  fromFormValues,
  isEditable,
  issueOptions,
  toFormValues,
  viewPayload,
} from "./proposal-fields";

describe("story points in the edit form (D55)", () => {
  const create = ProposalPayloadSchema.parse({
    kind: "create_issue",
    ref: "$new:1",
    projectKey: "PAY",
    issueType: "Story",
    summary: "Export credit notes",
    storyPoints: 5,
    storyPointsEstimated: true,
  });

  test("an untouched suggestion stays a suggestion", () => {
    expect(toFormValues(create).storyPoints).toBe("5");
    expect(ProposalPayloadSchema.parse(fromFormValues(create, toFormValues(create)))).toEqual(
      create,
    );
  });

  test("changing or clearing the points makes them the user's", () => {
    const changed = ProposalPayloadSchema.parse(
      fromFormValues(create, { ...toFormValues(create), storyPoints: "8" }),
    );
    expect(changed).toMatchObject({ storyPoints: 8, storyPointsEstimated: false });
    const cleared = ProposalPayloadSchema.parse(
      fromFormValues(create, { ...toFormValues(create), storyPoints: "" }),
    );
    expect(cleared).toMatchObject({
      storyPoints: null,
      storyPointsEstimated: false,
      storyPointsCleared: true,
    });
    // Setting a number again ends the clear.
    const again = ProposalPayloadSchema.parse(
      fromFormValues(cleared, { ...toFormValues(cleared), storyPoints: "2" }),
    );
    expect(again).toMatchObject({ storyPoints: 2, storyPointsCleared: false });
  });

  test("text that is no number fails validation; empty on an update means no change", () => {
    expect(
      ProposalPayloadSchema.safeParse(
        fromFormValues(create, { ...toFormValues(create), storyPoints: "lots" }),
      ).success,
    ).toBe(false);
    const update = ProposalPayloadSchema.parse({
      kind: "update_issue",
      target: "PAY-12",
      changes: { storyPoints: 5 },
    });
    expect(fromFormValues(update, { ...toFormValues(update), changes__storyPoints: "3" })).toEqual({
      kind: "update_issue",
      target: "PAY-12",
      changes: { storyPoints: 3 },
    });
    expect(
      fromFormValues(update, {
        ...toFormValues(update),
        changes__summary: "New title",
        changes__storyPoints: "",
      }),
    ).toEqual({ kind: "update_issue", target: "PAY-12", changes: { summary: "New title" } });
  });

  test("an Epic gets no points: the type change drops them and the field hides", () => {
    const values = { ...toFormValues(create), issueType: "Epic" };
    const epic = ProposalPayloadSchema.parse(fromFormValues(create, values));
    expect(epic).toMatchObject({
      issueType: "Epic",
      storyPoints: null,
      storyPointsEstimated: false,
      storyPointsCleared: false,
    });
    const spec = FIELD_SPECS.create_issue.find((s) => s.path === "storyPoints");
    expect(spec?.hidden?.(values)).toBe(true);
    expect(spec?.hidden?.(toFormValues(create))).toBe(false);
  });

  test("an update clears the ticket's points with the checkbox (FR-15.3), and round-trips", () => {
    const update = ProposalPayloadSchema.parse({
      kind: "update_issue",
      target: "PAY-12",
      changes: { summary: "x" },
    });
    const ticked = { ...toFormValues(update), changes__storyPoints__clear: "true" };
    const cleared = ProposalPayloadSchema.parse(fromFormValues(update, ticked));
    expect(cleared).toEqual({
      kind: "update_issue",
      target: "PAY-12",
      changes: { summary: "x", storyPoints: null },
    });
    const form = toFormValues(cleared);
    expect(form.changes__storyPoints__clear).toBe("true");
    expect(form.changes__storyPoints).toBe("");
    expect(fromFormValues(cleared, form)).toEqual(cleared);
    // The number field hides while the box is ticked; unticked, empty means no change.
    const number = FIELD_SPECS.update_issue.find((s) => s.type === "number");
    expect(number?.hidden?.(form)).toBe(true);
    expect(fromFormValues(cleared, { ...form, changes__storyPoints__clear: "" })).toEqual({
      kind: "update_issue",
      target: "PAY-12",
      changes: { summary: "x" },
    });
  });

  test("a stored create without points reads as none on the card", () => {
    const old = { ...create } as Record<string, unknown>;
    delete old.storyPoints;
    delete old.storyPointsEstimated;
    expect(viewPayload(old as never)).toMatchObject({
      storyPoints: null,
      storyPointsEstimated: false,
    });
  });
});

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

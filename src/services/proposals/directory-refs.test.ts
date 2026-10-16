/** `$person:n` and `$team:n` refs, and the pure helpers around new contacts and teams (D60). */
import { describe, expect, test } from "bun:test";
import { mergeItemProposals } from "@/services/intake/merge";
import { withLinkedItems } from "@/services/intake/thread";
import { groupSmallAsks } from "@/services/small-asks/bundle";
import { existingContact, existingTeam, nameKey } from "../directory/duplicates";
import { describeUses, noUses } from "../directory/uses";
import {
  createdIds,
  describePayload,
  directoryRefs,
  type ProposalPayload,
  ProposalPayloadSchema,
  placeholderRefs,
  resolveRefs,
} from "./schema";
import { directoryName, threadRefs, waitingMessage } from "./thread-refs";

const p = (v: Record<string, unknown>) => ProposalPayloadSchema.parse(v);
const person = (extra: Record<string, unknown> = {}) =>
  p({ kind: "create_person", ref: "$person:1", displayName: "Sarah Lee", ...extra });
const team = (extra: Record<string, unknown> = {}) =>
  p({ kind: "create_team", ref: "$team:1", name: "Payments", ...extra });
const wait = (extra: Record<string, unknown> = {}) =>
  p({
    kind: "link_dependency",
    target: "PAY-2",
    dependencyKind: "person",
    label: "cert",
    ownerPersonId: "$person:1",
    ...extra,
  });

describe("payloads", () => {
  test("parse with defaults; refs must have their own shape; an email must be one", () => {
    expect(person()).toEqual({
      kind: "create_person",
      ref: "$person:1",
      displayName: "Sarah Lee",
      title: null,
      email: null,
      jiraUsername: null,
      team: null,
      responsibilities: null,
      profile: {},
      note: null,
    });
    expect(ProposalPayloadSchema.safeParse({ ...person(), ref: "$team:1" }).success).toBe(false);
    expect(ProposalPayloadSchema.safeParse({ ...team(), ref: "$new:1" }).success).toBe(false);
    expect(ProposalPayloadSchema.safeParse({ ...person(), email: "nope" }).success).toBe(false);
    expect(describePayload(person({ title: "Staff engineer" }))).toBe(
      "Add contact Sarah Lee, Staff engineer",
    );
    expect(describePayload(team())).toBe("Add team Payments");
    expect(
      describePayload(p({ kind: "update_person", personId: "p1", changes: { team: null } })),
    ).toBe("Remove from their team");
  });

  test("refs: what a payload points at, with its own, and resolving them to ids", () => {
    const draft = p({
      kind: "draft_message",
      channel: "teams",
      intent: "request",
      recipientTeamId: "$team:2",
      issueKeys: ["$new:1"],
    });
    expect(placeholderRefs(draft)).toEqual(["$new:1", "$team:2"]);
    expect(placeholderRefs(person({ team: "$team:1" }), { includeOwn: true })).toEqual([
      "$person:1",
      "$team:1",
    ]);
    expect(
      directoryRefs(p({ kind: "update_person", personId: "p1", changes: { team: "t1" } })),
    ).toEqual(["p1", "t1"]);
    const made = new Map([
      ["$person:1", "p-sarah"],
      ["$team:1", "t-pay"],
      ["$team:2", "t-plat"],
      ["$new:1", "PAY-9"],
    ]);
    expect(resolveRefs(wait({ ownerTeamId: "$team:1" }), made)).toMatchObject({
      ownerPersonId: "p-sarah",
      ownerTeamId: "t-pay",
    });
    expect(resolveRefs(draft, made)).toMatchObject({
      recipientTeamId: "t-plat",
      issueKeys: ["PAY-9"],
    });
    // A create's own ref stays; what it points at resolves.
    expect(resolveRefs(person({ team: "$team:1" }), made)).toMatchObject({
      ref: "$person:1",
      team: "t-pay",
    });
    expect(
      resolveRefs(
        p({
          kind: "remember",
          memoryKind: "fact",
          content: "x",
          subjectType: "person",
          subjectId: "$person:1",
        }),
        made,
      ),
    ).toMatchObject({ subjectId: "p-sarah" });
    expect(
      resolveRefs(p({ kind: "update_person", personId: "p1", changes: { team: "$team:1" } }), made),
    ).toMatchObject({ changes: { team: "t-pay" } });
  });

  test("createdIds reads what executed creates made", () => {
    const row = (payload: ProposalPayload, status: string, result: unknown) => ({
      status,
      payload,
      editedPayload: null,
      result,
    });
    expect(
      createdIds([
        row(person(), "executed", { personId: "p-sarah" }),
        row(team(), "executed", { teamId: "t-pay" }),
        row(team({ ref: "$team:2" }), "pending", null),
        row(
          p({
            kind: "create_issue",
            ref: "$new:1",
            projectKey: "PAY",
            issueType: "Task",
            summary: "s",
          }),
          "executed",
          { issueKey: "PAY-9" },
        ),
      ]),
    ).toEqual(
      new Map([
        ["$person:1", "p-sarah"],
        ["$team:1", "t-pay"],
        ["$new:1", "PAY-9"],
      ]),
    );
  });
});

describe("intake plumbing", () => {
  const mp = (payload: ProposalPayload) => ({
    payload,
    rationale: "r",
    evidence: "e",
    confidence: 0.8,
  });

  test("the merge renumbers each kind of ref, puts teams then contacts first, and keeps one per name", () => {
    const merged = mergeItemProposals(
      [
        [mp(wait()), mp(person({ team: "$team:1" })), mp(team())],
        [
          mp(person({ displayName: "sarah  lee" })),
          mp(person({ ref: "$person:2", displayName: "Omar Haddad" })),
          mp(wait({ ownerPersonId: "$person:2", label: "approval" })),
        ],
      ],
      new Set(["$team:1"]),
    ).map((m) => m.payload);
    expect(merged).toMatchObject([
      { kind: "create_team", ref: "$team:2" },
      { kind: "create_person", ref: "$person:1", team: "$team:2" },
      { kind: "create_person", ref: "$person:2", displayName: "Omar Haddad" },
      { kind: "link_dependency", ownerPersonId: "$person:1" },
      { kind: "link_dependency", ownerPersonId: "$person:2", label: "approval" },
    ]);
  });

  test("items linked by a contact's ref are revised together", () => {
    const pending = new Map<number, ProposalPayload[]>([
      [0, [person()]],
      [1, [wait()]],
      [2, [team({ ref: "$team:3" })]],
    ]);
    expect(withLinkedItems([1], pending)).toEqual([0, 1]);
  });

  test("a wait on a contact not added yet stays out of a small ask's Track row", () => {
    const ask = p({
      kind: "create_issue",
      ref: "$new:1",
      projectKey: "OPS",
      issueType: "Task",
      summary: "Send the cert",
      smallAsk: true,
    });
    const row = (id: string, payload: ProposalPayload, status = "pending") => ({
      id,
      intakeItemId: "i1",
      kind: payload.kind,
      status,
      seq: Number(id),
      payload,
      editedPayload: null,
    });
    const list = [
      row("1", person()),
      row("2", ask),
      row("3", wait({ target: "$new:1" })),
      row("4", wait({ target: "$new:1", ownerPersonId: null, label: "vendor" })),
    ];
    const grouped = groupSmallAsks(list);
    expect(
      grouped.map((g) =>
        g.type === "track" ? `track:${g.members.map((m) => m.id)}` : g.proposal.id,
      ),
    ).toEqual(["1", "track:4", "3"]);
    // Once she is added, the wait joins.
    const done = groupSmallAsks([
      { ...list[0], status: "executed" } as (typeof list)[0],
      ...list.slice(1),
    ]);
    expect(done.find((g) => g.type === "track")).toMatchObject({
      members: [{ id: "3" }, { id: "4" }],
    });
  });
});

describe("directory helpers", () => {
  test("duplicates by name (case and spaces ignored), email or Jira user", () => {
    const people = [
      { id: "p1", displayName: "Sarah Lee", email: "s.lee@example.com", jiraUsername: "SLEE" },
    ];
    expect(nameKey(" Sarah  LEE ")).toBe("sarahlee");
    expect(existingContact(people, { displayName: "sarahlee" })?.id).toBe("p1");
    expect(existingContact(people, { displayName: "S", email: "S.Lee@example.com" })?.id).toBe(
      "p1",
    );
    expect(existingContact(people, { displayName: "S", jiraUsername: "slee" })?.id).toBe("p1");
    expect(existingContact(people, { displayName: "Sara Lee" })).toBeNull();
    expect(existingTeam([{ id: "t1", name: "Data Platform" }], "data platform")?.id).toBe("t1");
    expect(existingTeam([{ id: "t1", name: "Data Platform" }], "")).toBeNull();
  });

  test("what still uses a contact, in words", () => {
    expect(describeUses(noUses())).toEqual([]);
    expect(describeUses({ ...noUses(), waits: ["w"], drafts: ["a", "b"], notes: 1 })).toEqual([
      "a wait",
      "2 drafts",
      "a context note",
    ]);
  });

  test("a thread's new contacts and teams name their refs", () => {
    const rows = [
      { status: "pending", payload: person(), editedPayload: null },
      { status: "superseded", payload: team({ name: "Old" }), editedPayload: null },
      { status: "executed", payload: team(), editedPayload: null, result: { teamId: "t-pay" } },
      {
        status: "revoked",
        payload: person({ ref: "$person:2", displayName: "Omar Haddad" }),
        editedPayload: null,
        result: { personId: "p-gone" },
      },
    ];
    const refs = threadRefs(rows);
    // Selects offer only what may still run; an executed one is a real row by now.
    expect(refs.people).toEqual([{ ref: "$person:1", name: "Sarah Lee" }]);
    expect(refs.teams).toEqual([]);
    expect([...refs.made]).toEqual([["$team:1", "t-pay"]]);
    const known = (id: string) =>
      id === "p-ana" ? "Ana Bell" : id === "t-pay" ? "Payments team" : null;
    expect(directoryName("$person:1", known, refs)).toBe("Sarah Lee (new)");
    // Once made, by the row; once revoked, by the name it had.
    expect(directoryName("$team:1", known, refs)).toBe("Payments team");
    expect(directoryName("$person:2", known, refs)).toBe("Omar Haddad");
    expect(directoryName("$team:4", known, refs)).toBe("new team 4");
    expect(directoryName("p-ana", known, refs)).toBe("Ana Bell");
    expect(directoryName(null, known, refs)).toBeNull();
    expect(waitingMessage(["$person:1"], refs)).toBe(
      "Approve the new contact Sarah Lee first; this proposal needs them.",
    );
  });
});

import { describe, expect, test } from "bun:test";
import { type BundleProposal, bundleLine, groupSmallAsks, trackOrder } from "./bundle";

const create = (id: string, ref: string, smallAsk: boolean, item = "i1"): BundleProposal => ({
  id,
  intakeItemId: item,
  kind: "create_issue",
  status: "pending",
  seq: 0,
  payload: {
    kind: "create_issue",
    ref,
    projectKey: "OPS",
    issueType: "Task",
    summary: `Ask ${id}`,
    smallAsk,
  },
  editedPayload: null,
});
const dep = (id: string, target: string, item = "i1", status = "pending"): BundleProposal => ({
  id,
  intakeItemId: item,
  kind: "link_dependency",
  status,
  seq: 0,
  payload: { kind: "link_dependency", target, dependencyKind: "person", label: "Finance" },
  editedPayload: null,
});
const shape = (entries: ReturnType<typeof groupSmallAsks>) =>
  entries.map((e) =>
    e.type === "card" ? e.proposal.id : `track ${e.create.id} [${e.members.map((m) => m.id)}]`,
  );

describe("groupSmallAsks (D44)", () => {
  test("a small-ask create takes the same item's proposals that point at its ref", () => {
    const list = [
      create("c1", "$new:1", true),
      dep("d1", "$new:1"),
      dep("d2", "PAY-2"),
      // Another item's proposal on the same ref is not part of the row.
      dep("d3", "$new:1", "i2"),
      { ...dep("x", "$new:1"), status: "superseded" },
    ];
    expect(shape(groupSmallAsks(list))).toEqual(["track c1 [d1]", "d2", "d3"]);
  });

  test("planned-work creates stay cards; old payloads without smallAsk too", () => {
    const old = create("c0", "$new:1", false);
    old.payload = { ...(old.payload as object), smallAsk: undefined };
    expect(shape(groupSmallAsks([old, dep("d1", "$new:1")]))).toEqual(["c0", "d1"]);
  });

  test("an edited payload decides, and each member joins one row only", () => {
    const edited = { ...create("c2", "$new:2", false) };
    edited.editedPayload = { ...(edited.payload as object), smallAsk: true };
    const list = [create("c1", "$new:1", true), edited, dep("d1", "$new:2"), dep("d2", "$new:1")];
    expect(shape(groupSmallAsks(list))).toEqual(["track c1 [d2]", "track c2 [d1]"]);
  });

  test("only bundle kinds join: other writes on the new ticket stay cards under the row", () => {
    const other = (id: string, kind: string, payload: object): BundleProposal => ({
      ...dep(id, "$new:1"),
      kind,
      payload: { kind, ...payload },
    });
    const list = [
      create("c1", "$new:1", true),
      dep("d1", "$new:1"),
      other("cm", "add_comment", { target: "$new:1", bodyMd: "Started" }),
      other("tr", "transition_issue", { target: "$new:1", toStatus: "In Progress" }),
      other("up", "update_issue", { target: "$new:1", changes: { priority: "High" } }),
      other("dm", "draft_message", {
        channel: "teams",
        intent: "fyi",
        recipientPersonId: "p1",
        issueKeys: ["$new:1"],
      }),
    ];
    expect(shape(groupSmallAsks(list))).toEqual(["track c1 [d1]", "cm", "tr", "up", "dm"]);
  });

  test("refs created earlier in the thread do not keep a member out", () => {
    const executed = { ...create("c2", "$new:2", false), status: "executed" };
    const list = [create("c1", "$new:1", true), executed, dep("d1", "$new:1")];
    expect(shape(groupSmallAsks(list))).toEqual(["track c1 [d1]", "c2"]);
    expect(shape(groupSmallAsks([create("c1", "$new:1", true)], new Set(["$new:2"])))).toEqual([
      "track c1 []",
    ]);
  });

  test("a blocker link on the new ticket joins; one that also needs another new ticket does not", () => {
    const linkOf = (id: string, target: string, blocker: string): BundleProposal => ({
      ...dep(id, target),
      kind: "link_issues",
      payload: { kind: "link_issues", target, blocker },
    });
    const list = [
      create("c1", "$new:1", true),
      linkOf("l1", "$new:1", "PLAT-1"),
      // Waits on a second new ticket that is not created yet.
      linkOf("l2", "$new:1", "$new:2"),
      create("c2", "$new:2", false),
    ];
    expect(shape(groupSmallAsks(list))).toEqual(["track c1 [l1]", "l2", "c2"]);
    // Once $new:2 exists, the same link may join.
    const executed = list.map((p) => (p.id === "c2" ? { ...p, status: "executed" } : p));
    expect(shape(groupSmallAsks(executed))).toEqual(["track c1 [l1,l2]", "c2"]);
    expect(bundleLine({ kind: "link_issues", target: "$new:1", blocker: "PLAT-1" }, "$new:1")).toBe(
      "Blocked by PLAT-1",
    );
    expect(bundleLine({ kind: "link_issues", target: "PAY-2", blocker: "$new:1" }, "$new:1")).toBe(
      "Blocks PAY-2",
    );
  });

  test("the row face has one line per member", () => {
    expect(
      bundleLine({
        kind: "link_dependency",
        target: "$new:1",
        dependencyKind: "team",
        label: "Finance",
        ownerPersonId: null,
        ownerTeamId: null,
        mirror: false,
        externalRef: null,
        externalUrl: null,
        expectedAt: null,
        nextFollowupAt: null,
      }),
    ).toBe("Waits on Finance");
  });

  test("Track runs the create first, then the members by seq, skipping decided ones", () => {
    const c = create("c1", "$new:1", true);
    const members = [
      { ...dep("d2", "$new:1"), seq: 3 },
      { ...dep("d1", "$new:1"), seq: 2 },
      { ...dep("d0", "$new:1", "i1", "executed"), seq: 1 },
      { ...dep("df", "$new:1", "i1", "failed"), seq: 4 },
    ];
    expect(trackOrder(c, members)).toEqual(["c1", "d1", "d2", "df"]);
    expect(trackOrder({ ...c, status: "executed" }, members)).toEqual(["d1", "d2", "df"]);
  });
});

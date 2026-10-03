import { describe, expect, test } from "bun:test";
import { type BundleProposal, groupSmallAsks, trackOrder } from "./bundle";

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

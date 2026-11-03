import { describe, expect, test } from "bun:test";
import type { IssueLink } from "@/services/jira/schemas";
import {
  type GroupInput,
  type GroupTicket,
  groupWork,
  isActive,
  type Member,
  stems,
} from "./grouping";

const SPRINT = "Payments 15";

const ticket = (key: string, patch: Partial<GroupTicket> = {}): GroupTicket => ({
  key,
  summary: `Ticket ${key}`,
  issueType: "Story",
  isSubtask: false,
  statusCategory: "indeterminate",
  assignee: "me",
  parentKey: null,
  epicKey: null,
  epicName: null,
  sprint: SPRINT,
  labels: [],
  links: [],
  requesterId: null,
  stale: false,
  ...patch,
});

/** "key is blocked by blocker", as Jira embeds it on `key`. */
const blockedBy = (blocker: string, category = "indeterminate"): IssueLink => ({
  id: `l-${blocker}`,
  type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
  inwardIssue: {
    key: blocker,
    fields: { status: { name: "In Progress", statusCategory: { key: category } } },
  },
});

const input = (tickets: GroupTicket[], patch: Partial<GroupInput> = {}): GroupInput => ({
  me: "me",
  activeSprints: new Set([SPRINT]),
  smallAskLabel: "small-ask",
  tickets,
  actedOn: new Set(),
  namedTogether: [],
  waits: [],
  members: new Map(),
  activeItems: new Set(),
  corrections: { together: [], apart: [] },
  cap: 8,
  ...patch,
});

const groupsOf = (r: ReturnType<typeof groupWork>) =>
  r.created.map((g) => g.keys.map((k) => k.key).sort());

describe("active tickets (D61)", () => {
  const base = input([]);
  test("assigned to the user and in progress, or in an active sprint", () => {
    expect(isActive(ticket("A-1", { sprint: null }), base)).toBe(true);
    expect(isActive(ticket("A-2", { statusCategory: "new" }), base)).toBe(true);
    expect(isActive(ticket("A-3", { statusCategory: "new", sprint: null }), base)).toBe(false);
    expect(isActive(ticket("A-4", { assignee: "ana" }), base)).toBe(false);
  });
  test("small asks and tickets acted on count; done, epics and out-of-scope do not", () => {
    expect(
      isActive(ticket("A-5", { statusCategory: "new", sprint: null, labels: ["Small-Ask"] }), base),
    ).toBe(true);
    expect(
      isActive(ticket("A-6", { assignee: "ana" }), { ...base, actedOn: new Set(["A-6"]) }),
    ).toBe(true);
    expect(isActive(ticket("A-7", { statusCategory: "done" }), base)).toBe(false);
    expect(isActive(ticket("A-8", { issueType: "Epic" }), base)).toBe(false);
    expect(isActive(ticket("A-9", { stale: true }), base)).toBe(false);
  });
});

describe("groupWork", () => {
  test("an epic with two active stories and a sub-task is one item, named after the epic", () => {
    const r = groupWork(
      input([
        ticket("PAY-1", { issueType: "Epic", summary: "Card payments", assignee: "ana" }),
        ticket("PAY-2", {
          epicKey: "PAY-1",
          epicName: "Card payments",
          summary: "Retry declined cards",
        }),
        ticket("PAY-3", {
          epicKey: "PAY-1",
          epicName: "Card payments",
          summary: "Show declined card retries",
        }),
        ticket("PAY-4", { isSubtask: true, parentKey: "PAY-2", summary: "Backoff" }),
      ]),
    );
    expect(groupsOf(r)).toEqual([["PAY-2", "PAY-3", "PAY-4"]]);
    expect(r.created[0]?.name).toBe("Card payments");
  });

  test("the same epic alone is one signal, not enough", () => {
    const r = groupWork(
      input([
        ticket("PAY-2", { epicKey: "PAY-1", summary: "Retry declined cards" }),
        ticket("PAY-3", { epicKey: "PAY-1", summary: "Refund report" }),
      ]),
    );
    expect(groupsOf(r)).toEqual([["PAY-2"], ["PAY-3"]]);
  });

  test("two tickets linked by blocks are one item; an open blocker joins as related", () => {
    const r = groupWork(
      input([
        ticket("PAY-12", {
          summary: "Renew the payment cert",
          links: [blockedBy("PAY-13"), blockedBy("PLAT-812")],
        }),
        ticket("PAY-13", { summary: "Rotate keys" }),
        ticket("PLAT-812", {
          assignee: "sam",
          sprint: null,
          stale: true,
          summary: "Issue the cert",
        }),
      ]),
    );
    expect(groupsOf(r)).toEqual([["PAY-12", "PAY-13", "PLAT-812"]]);
    const keys = r.created[0]?.keys ?? [];
    expect(keys[0]).toEqual({ key: "PAY-12", role: "primary" });
    expect(keys.find((k) => k.key === "PLAT-812")?.role).toBe("related");
    expect(r.created[0]?.name).toBe("Renew the payment cert");
  });

  test("a closed blocker does not join", () => {
    const r = groupWork(
      input([ticket("PAY-12", { links: [blockedBy("PLAT-812", "done")] })], {
        blockers: { "PLAT-812": { statusCategory: "done" } },
      }),
    );
    expect(groupsOf(r)).toEqual([["PAY-12"]]);
  });

  test("a thread naming two tickets puts them in one item", () => {
    const r = groupWork(
      input(
        [
          ticket("PAY-5", { summary: "Invoice export" }),
          ticket("OPS-9", { summary: "Disk alert" }),
        ],
        {
          namedTogether: [["PAY-5", "OPS-9", "NOPE-1"]],
        },
      ),
    );
    expect(groupsOf(r)).toEqual([["OPS-9", "PAY-5"]]);
  });

  test("open waits on the same owner within one epic join", () => {
    const r = groupWork(
      input([ticket("PAY-5", { epicKey: "PAY-1" }), ticket("PAY-6", { epicKey: "PAY-1" })], {
        waits: [
          { issueKey: "PAY-5", owner: "person:sarah" },
          { issueKey: "PAY-6", owner: "person:sarah" },
        ],
      }),
    );
    expect(groupsOf(r)).toEqual([["PAY-5", "PAY-6"]]);
  });

  test("a 12-ticket epic is not merged past the cap, and that is a doubt", () => {
    const tickets = Array.from({ length: 12 }, (_, i) =>
      ticket(`PAY-${i + 10}`, {
        epicKey: "PAY-1",
        epicName: "Ledger",
        summary: `Ledger migration step ${i + 1}`,
      }),
    );
    const r = groupWork(input(tickets));
    expect(Math.max(...r.created.map((g) => g.keys.length))).toBeLessThanOrEqual(8);
    expect(r.created.reduce((n, g) => n + g.keys.length, 0)).toBe(12);
    expect(r.doubts.some((d) => d.reason === "cap")).toBe(true);
  });

  test("stable: a ticket in an item stays, new ones join it, two items are never merged", () => {
    const members = new Map<string, Member>([
      ["PAY-12", { itemId: "w1", role: "primary", addedBy: "code" }],
      ["PAY-30", { itemId: "w2", role: "primary", addedBy: "code" }],
    ]);
    const r = groupWork(
      input(
        [
          ticket("PAY-12", { links: [blockedBy("PAY-30")] }),
          ticket("PAY-30"),
          ticket("PAY-31", { isSubtask: true, parentKey: "PAY-12" }),
        ],
        { members, activeItems: new Set(["w1", "w2"]) },
      ),
    );
    expect(r.created).toEqual([]);
    expect(r.joins).toEqual([{ key: "PAY-31", itemId: "w1", role: "primary" }]);
    expect(r.doubts).toEqual([{ reason: "items", a: "PAY-12", b: "PAY-30" }]);
  });

  test("the same input gives the same result in any order", () => {
    const tickets = [
      ticket("PAY-2", { epicKey: "PAY-1", summary: "Retry declined cards" }),
      ticket("PAY-3", { epicKey: "PAY-1", summary: "Declined card emails" }),
      ticket("OPS-4", { links: [blockedBy("PAY-2")] }),
    ];
    const a = groupWork(input(tickets));
    const b = groupWork(input([...tickets].reverse()));
    expect(groupsOf(a)).toEqual(groupsOf(b));
    expect(a.created.map((g) => g.name)).toEqual(b.created.map((g) => g.name));
  });

  test("a split is kept on the next run: the corrections keep the two apart", () => {
    const tickets = [
      ticket("PAY-12", { links: [blockedBy("PAY-13")] }),
      ticket("PAY-13"),
      ticket("PAY-14", { isSubtask: true, parentKey: "PAY-13" }),
    ];
    // After the user split PAY-13 off PAY-12's item.
    const members = new Map<string, Member>([
      ["PAY-12", { itemId: "w1", role: "primary", addedBy: "code" }],
      ["PAY-13", { itemId: "w2", role: "primary", addedBy: "user" }],
    ]);
    const corrections = { together: [], apart: [{ keys: ["PAY-13"], from: ["PAY-12"] }] };
    const r = groupWork(
      input(tickets, { members, activeItems: new Set(["w1", "w2"]), corrections }),
    );
    expect(r.created).toEqual([]);
    expect(r.joins).toEqual([{ key: "PAY-14", itemId: "w2", role: "primary" }]);
    // The user said no: not asked again.
    expect(r.doubts).toEqual([]);

    // Without items yet (a fresh run), "apart" still keeps a strong link from joining.
    const fresh = groupWork(input(tickets.slice(0, 2), { corrections }));
    expect(groupsOf(fresh)).toEqual([["PAY-12"], ["PAY-13"]]);
  });

  test("together corrections join tickets with no edge, past nothing else", () => {
    const r = groupWork(
      input([ticket("PAY-5", { summary: "Invoices" }), ticket("OPS-9", { summary: "Alerts" })], {
        corrections: { together: [["PAY-5", "OPS-9"]], apart: [] },
      }),
    );
    expect(groupsOf(r)).toEqual([["OPS-9", "PAY-5"]]);
  });
});

describe("stems", () => {
  test("drops short and common words and plain endings", () => {
    expect([...stems("Update the payment retries for declined cards")]).toEqual([
      "payment",
      "retry",
      "declin",
      "card",
    ]);
  });
});

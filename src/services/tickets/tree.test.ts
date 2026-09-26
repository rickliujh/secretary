import { describe, expect, test } from "bun:test";
import {
  ALL_CATEGORIES,
  buildTree,
  ftsQuery,
  type TicketFilters,
  type TicketNode,
  type TicketRow,
} from "./tree";

const row = (key: string, patch: Partial<TicketRow> = {}): TicketRow => ({
  key,
  projectKey: key.split("-")[0] ?? "",
  issueType: "Story",
  isSubtask: false,
  summary: key,
  status: "To Do",
  statusCategory: "new",
  priority: null,
  assignee: null,
  assigneeDisplay: null,
  parentKey: null,
  epicKey: null,
  epicName: null,
  dueDate: null,
  updated: "2026-09-01T00:00:00.000Z",
  isTrackedEpic: false,
  stale: false,
  ...patch,
});

const none: TicketFilters = {
  textMatches: null,
  statusCategories: ALL_CATEGORIES,
  assignee: null,
  project: null,
  showStale: false,
};

const rows = [
  row("PAY-1", { issueType: "Epic", isTrackedEpic: true }),
  row("PAY-10", { epicKey: "PAY-1", assignee: "ana" }),
  row("PAY-2", { epicKey: "PAY-1", statusCategory: "done" }),
  row("PAY-3", { issueType: "Sub-task", isSubtask: true, parentKey: "PAY-10", assignee: "rliu" }),
  row("OPS-1", { issueType: "Epic" }),
  row("OPS-7", { issueType: "Task", updated: "2026-09-20T00:00:00.000Z" }),
  row("OPS-8", { issueType: "Task", updated: "2026-09-21T00:00:00.000Z" }),
  row("PAY-4", { epicKey: "PAY-99" }), // epic not cached
  row("PAY-5", { stale: true }),
];

const shape = (nodes: TicketNode[]): unknown =>
  nodes.map((n) => (n.children.length ? { [n.key]: shape(n.children) } : n.key));

describe("buildTree", () => {
  test("nests epics, stories and sub-tasks; tracked epics first, then epics, then loose issues by recency", () => {
    expect(shape(buildTree(rows, none))).toEqual([
      { "PAY-1": ["PAY-2", { "PAY-10": ["PAY-3"] }] },
      "OPS-1",
      "OPS-8",
      "OPS-7",
      "PAY-4",
    ]);
  });

  test("filters keep ancestors of matches, flagged as context", () => {
    const tree = buildTree(rows, { ...none, assignee: "rliu" });
    expect(shape(tree)).toEqual([{ "PAY-1": [{ "PAY-10": ["PAY-3"] }] }]);
    expect(tree[0]?.matched).toBe(false);
    expect(tree[0]?.children[0]?.children[0]?.matched).toBe(true);
  });

  test("status category and text filters combine", () => {
    const tree = buildTree(rows, {
      ...none,
      statusCategories: new Set(["done"]),
      textMatches: new Set(["PAY-2", "OPS-7"]),
    });
    expect(shape(tree)).toEqual([{ "PAY-1": ["PAY-2"] }]);
  });

  test("unassigned and project filters", () => {
    expect(shape(buildTree(rows, { ...none, assignee: "unassigned", project: "OPS" }))).toEqual([
      "OPS-1",
      "OPS-8",
      "OPS-7",
    ]);
  });

  test("stale issues are hidden unless asked for", () => {
    expect(JSON.stringify(shape(buildTree(rows, none)))).not.toContain("PAY-5");
    expect(JSON.stringify(shape(buildTree(rows, { ...none, showStale: true })))).toContain("PAY-5");
  });

  test("2,000 issues build in well under the 1 second budget", () => {
    const many: TicketRow[] = [];
    for (let e = 1; e <= 40; e++) {
      many.push(row(`BIG-${e}`, { issueType: "Epic", isTrackedEpic: e <= 5 }));
      for (let s = 0; s < 35; s++) {
        const key = `BIG-${1000 + e * 100 + s}`;
        many.push(row(key, { epicKey: `BIG-${e}`, assignee: s % 3 ? "ana" : null }));
        if (s < 14)
          many.push(row(`BIG-${100000 + e * 100 + s}`, { isSubtask: true, parentKey: key }));
      }
    }
    expect(many.length).toBeGreaterThanOrEqual(2000);
    const started = performance.now();
    buildTree(many, none);
    buildTree(many, { ...none, assignee: "ana", statusCategories: new Set(["new"]) });
    expect(performance.now() - started).toBeLessThan(100);
  });
});

describe("ftsQuery", () => {
  test("quotes tokens as prefixes and neutralises FTS syntax", () => {
    expect(ftsQuery('ledger "export" OR NOT*')).toBe('"ledger"* "export"* "OR"* "NOT"*');
    expect(ftsQuery("  ")).toBeNull();
    expect(ftsQuery("PAY-2")).toBe('"PAY"* "2"*');
  });
});

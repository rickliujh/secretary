import { describe, expect, test } from "bun:test";
import { DEFAULT_WEIGHTS } from "@/services/settings/schema";
import { blockInfo, buildDashboard, type DashboardInputs, type DashIssue } from "./sections";

const TODAY = "2026-09-25";
const NOW = "2026-09-25T09:00:00.000Z";

const issue = (key: string, p: Partial<DashIssue> = {}): DashIssue => ({
  key,
  issueType: "Story",
  isSubtask: false,
  summary: key,
  status: "In Progress",
  statusCategory: "indeterminate",
  priority: "Medium",
  assignee: "me",
  assigneeDisplay: "Me",
  epicKey: null,
  dueDate: null,
  updated: "2026-09-24T00:00:00.000Z",
  links: [],
  pinned: false,
  snoozedUntil: null,
  priorityOverride: null,
  lastViewedAt: null,
  ...p,
});

const blockedByOps7 = [
  {
    type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
    inwardIssue: { key: "OPS-7", fields: { status: { statusCategory: { key: "new" } } } },
  },
];

const inputs = (p: Partial<DashboardInputs> = {}): DashboardInputs => ({
  me: "me",
  trackedEpics: ["EP-1"],
  issues: [],
  dependencies: [],
  comments: [],
  ...p,
});

describe("blockInfo", () => {
  test("unresolved blockers and blocked issues; resolved links ignored", () => {
    expect(
      blockInfo([
        ...blockedByOps7,
        {
          type: { name: "Blocks" },
          outwardIssue: { key: "B-2", fields: { status: { statusCategory: { key: "done" } } } },
        },
        { type: { name: "Blocks" }, outwardIssue: { key: "B-3" } },
        { type: { name: "Relates" }, inwardIssue: { key: "R-1" } },
      ]),
    ).toEqual({ blockedBy: ["OPS-7"], blocks: ["B-3"] });
  });
});

describe("buildDashboard", () => {
  test("Top focus covers my work, tracked epics, pins and dependencies; skips done, epics and snoozed", () => {
    const d = buildDashboard(
      inputs({
        issues: [
          issue("MINE-1"),
          issue("OTHER-1", { assignee: "ana" }),
          issue("EPICCHILD-1", { assignee: "ana", epicKey: "EP-1" }),
          issue("PIN-1", { assignee: "ana", pinned: true }),
          issue("DONE-1", { statusCategory: "done" }),
          issue("EP-1", { issueType: "Epic" }),
          issue("SNOOZE-1", { snoozedUntil: "2026-09-30T00:00:00.000Z" }),
          issue("DEP-1", { assignee: "ana" }),
        ],
        dependencies: [
          {
            id: "d1",
            issueKey: "DEP-1",
            label: "Vendor",
            externalRef: null,
            status: "open",
            expectedAt: "2026-09-20",
            nextFollowupAt: null,
            ownerName: "Acme",
          },
        ],
      }),
      DEFAULT_WEIGHTS,
      TODAY,
      NOW,
    );
    expect(d.topFocus.map((f) => f.key).sort()).toEqual([
      "DEP-1",
      "EPICCHILD-1",
      "MINE-1",
      "PIN-1",
    ]);
    expect(d.topFocus[0]?.key).toBe("PIN-1");
    expect(d.snoozed).toBe(1);
    expect(d.topFocus.find((f) => f.key === "DEP-1")?.contributions.map((c) => c.reason)).toContain(
      "Waiting on Vendor, 5 days overdue",
    );
  });

  test("Waiting on me: unseen comments by others on my issues, and mentions anywhere", () => {
    const d = buildDashboard(
      inputs({
        issues: [
          issue("A-1"),
          issue("A-2", { lastViewedAt: "2026-09-25T08:00:00.000Z" }),
          issue("B-1", { assignee: "ana" }),
        ],
        comments: [
          {
            issueKey: "A-1",
            author: "ana",
            authorDisplay: "Ana",
            created: "2026-09-25T07:00:00.000Z",
            mentionsMe: false,
          },
          {
            issueKey: "A-2",
            author: "ana",
            authorDisplay: "Ana",
            created: "2026-09-25T07:30:00.000Z",
            mentionsMe: false,
          },
          {
            issueKey: "B-1",
            author: "tom",
            authorDisplay: "Tom",
            created: "2026-09-24T12:00:00.000Z",
            mentionsMe: true,
          },
          {
            issueKey: "A-1",
            author: "me",
            authorDisplay: "Me",
            created: "2026-09-24T07:00:00.000Z",
            mentionsMe: false,
          },
        ],
      }),
      DEFAULT_WEIGHTS,
      TODAY,
      NOW,
    );
    expect(d.waitingOnMe.map((w) => [w.issue.key, w.reasons[0]])).toEqual([
      ["A-1", "Ana commented"],
      ["B-1", "Tom mentioned you"],
    ]);
  });

  test("I am waiting on, at risk and due soon", () => {
    const d = buildDashboard(
      inputs({
        issues: [
          issue("BLK-1", { links: blockedByOps7 }),
          issue("OLD-1", { updated: "2026-09-01T00:00:00.000Z" }),
          issue("LATE-1", { dueDate: "2026-09-23" }),
          issue("SOON-1", { dueDate: "2026-09-27", statusCategory: "new", status: "To Do" }),
          issue("LATER-1", { dueDate: "2026-10-30" }),
        ],
        dependencies: [
          {
            id: "d1",
            issueKey: "BLK-1",
            label: "Network",
            externalRef: null,
            status: "waiting",
            expectedAt: "2026-09-24",
            nextFollowupAt: null,
            ownerName: "Network",
          },
          {
            id: "d2",
            issueKey: "BLK-1",
            label: "Fine",
            externalRef: null,
            status: "waiting",
            expectedAt: "2026-10-24",
            nextFollowupAt: null,
            ownerName: "Network",
          },
        ],
      }),
      DEFAULT_WEIGHTS,
      TODAY,
      NOW,
    );
    expect(d.iAmWaitingOn.map((x) => [x.label, x.overdueDays])).toEqual([["Network", 1]]);
    const risk = Object.fromEntries(d.atRisk.map((r) => [r.issue.key, r.reasons]));
    expect(risk["BLK-1"]).toEqual(["Blocked by OPS-7", "Waiting on Network (1d overdue)"]);
    expect(risk["OLD-1"]).toEqual(["No updates for 24 days"]);
    expect(risk["LATE-1"]).toEqual(["2 days past due"]);
    expect(risk["SOON-1"]).toEqual(["Due in 2 days and not started"]);
    expect(d.dueSoon.map((x) => [x.key, x.daysLeft])).toEqual([
      ["LATE-1", -2],
      ["SOON-1", 2],
    ]);
  });

  test("epic health counts children by category, blocked and stale", () => {
    const d = buildDashboard(
      inputs({
        issues: [
          issue("EP-1", { issueType: "Epic", summary: "Billing" }),
          issue("C-1", { epicKey: "EP-1", statusCategory: "done" }),
          issue("C-2", { epicKey: "EP-1", links: blockedByOps7 }),
          issue("C-3", {
            epicKey: "EP-1",
            statusCategory: "new",
            updated: "2026-08-01T00:00:00.000Z",
          }),
          issue("C-3a", { epicKey: "EP-1", isSubtask: true }),
        ],
      }),
      DEFAULT_WEIGHTS,
      TODAY,
      NOW,
    );
    expect(d.epicHealth).toEqual([
      expect.objectContaining({
        key: "EP-1",
        total: 3,
        done: 1,
        inProgress: 1,
        todo: 1,
        blocked: 1,
        stale: 1,
      }),
    ]);
  });

  test("2,000 issues build well inside the 1 second budget (FR-5 AC)", () => {
    const issues = Array.from({ length: 2000 }, (_, n) =>
      issue(`BIG-${n}`, {
        epicKey: n % 3 ? "EP-1" : null,
        assignee: n % 2 ? "me" : "ana",
        dueDate: n % 5 ? null : "2026-09-28",
        links: n % 7 ? [] : blockedByOps7,
        updated: n % 4 ? "2026-09-24T00:00:00.000Z" : "2026-08-01T00:00:00.000Z",
      }),
    );
    const comments = issues.slice(0, 500).map((i) => ({
      issueKey: i.key,
      author: "ana",
      authorDisplay: "Ana",
      created: NOW,
      mentionsMe: false,
    }));
    const started = performance.now();
    const d = buildDashboard(inputs({ issues, comments }), DEFAULT_WEIGHTS, TODAY, NOW);
    expect(performance.now() - started).toBeLessThan(150);
    expect(d.topFocus).toHaveLength(10);
  });
});

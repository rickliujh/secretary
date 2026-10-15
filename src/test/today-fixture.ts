/**
 * One snapshot that mixes small asks, waits, blockers and sprint work, for the
 * Today and sweep tests (Phase 16). Wednesday 7 October 2026, 09:00 UTC.
 */
import type { DashDependency, DashIssue } from "@/services/dashboard/sections";
import type { TodayInputs } from "@/services/dashboard/today";

export const TODAY = "2026-10-07";
export const NOW = "2026-10-07T09:00:00.000Z";
export const SPRINT = "Payments 15";

export const issue = (key: string, p: Partial<DashIssue> = {}): DashIssue => ({
  key,
  issueType: "Task",
  isSubtask: false,
  summary: `${key} summary`,
  status: "In Progress",
  statusCategory: "indeterminate",
  priority: "Medium",
  assignee: "me",
  assigneeDisplay: "Me",
  epicKey: null,
  sprint: SPRINT,
  dueDate: null,
  created: "2026-09-28T09:00:00.000Z",
  updated: "2026-10-06T09:00:00.000Z",
  labels: [],
  links: [],
  pinned: false,
  snoozedUntil: null,
  priorityOverride: null,
  lastViewedAt: null,
  requester: null,
  ...p,
});

export const ask = (key: string, p: Partial<DashIssue> = {}) =>
  issue(key, { labels: ["small-ask"], sprint: SPRINT, ...p });

export const wait = (
  id: string,
  issueKey: string,
  p: Partial<DashDependency> = {},
): DashDependency => ({
  id,
  issueKey,
  label: `${id} label`,
  externalRef: null,
  status: "waiting",
  expectedAt: null,
  nextFollowupAt: null,
  ownerName: "Acme",
  requestedAt: "2026-09-20T09:00:00.000Z",
  lastFollowupAt: null,
  ownerAway: null,
  ...p,
});

const blocksType = { name: "Blocks", inward: "is blocked by", outward: "blocks" };
export const blockedBy = (key: string, category = "indeterminate") => [
  {
    type: blocksType,
    inwardIssue: { key, fields: { status: { name: key, statusCategory: { key: category } } } },
  },
];

export const comment = (issueKey: string, created: string, who = "Ana", mentionsMe = false) => ({
  issueKey,
  author: who.toLowerCase(),
  authorDisplay: who,
  created,
  mentionsMe,
});

/** The mixed snapshot; `patch` overrides any input. */
export const mixedInputs = (patch: Partial<TodayInputs> = {}): TodayInputs => ({
  me: "me",
  trackedEpics: [],
  sprints: [
    { id: 1, name: SPRINT, state: "active", boardId: 1, start: "2026-09-28", end: "2026-10-09" },
  ],
  issues: [
    issue("WOKE-1"),
    ask("ASK-1", {
      dueDate: "2026-10-09",
      created: "2026-10-04T09:00:00.000Z",
      requester: { id: "p1", name: "Priya Shah" },
    }),
    ask("ASK-2", { created: "2026-09-20T09:00:00.000Z" }),
    ask("ASK-3"),
    ask("ASK-4", { links: blockedBy("OPS-7") }),
    ask("ASK-5", { snoozedUntil: "2026-10-09T00:00:00.000Z" }),
    ask("ASK-6"),
    ask("ASK-7", { assignee: "ana" }),
    ask("ASK-8", { statusCategory: "done", status: "Done" }),
    issue("BLK-1", { links: blockedBy("OPS-8") }),
    issue("CMT-1"),
    issue("SPR-1", { priority: "High" }),
    issue("SPR-2"),
    issue("LATE-1", { sprint: null, dueDate: "2026-10-05" }),
    issue("SNZ-1", { links: blockedBy("OPS-9"), snoozedUntil: "2026-10-09T00:00:00.000Z" }),
  ],
  dependencies: [
    wait("d-over", "SPR-1", { expectedAt: "2026-10-01" }),
    wait("d-follow", "SPR-2", { nextFollowupAt: "2026-10-06" }),
    wait("d-back", "SPR-2", {
      // Set before the leave; a chase date after the back day would end "is back" (D47).
      nextFollowupAt: "2026-10-02",
      ownerName: "Bob",
      // Monday 5 October; back on Tuesday the 6th.
      ownerAway: { name: "Bob", awayUntil: "2026-10-05" },
    }),
    wait("d-asleep", "SPR-1", {
      nextFollowupAt: "2026-10-06",
      ownerName: "Carl",
      ownerAway: { name: "Carl", awayUntil: "2026-10-14" },
    }),
    wait("d-ask", "ASK-3", { expectedAt: "2026-10-20" }),
    wait("d-snz", "SNZ-1", { expectedAt: "2026-10-01" }),
    wait("d-done", "SPR-1", { status: "resolved" }),
  ],
  comments: [
    comment("ASK-6", "2026-10-07T08:00:00.000Z", "Dana"),
    comment("CMT-1", "2026-10-07T07:00:00.000Z", "Ana"),
    comment("WOKE-1", "2026-10-07T06:00:00.000Z", "Ana"),
  ],
  woken: [
    {
      key: "WOKE-1",
      summary: "WOKE-1 summary",
      unblockedAt: "2026-10-06T10:00:00.000Z",
      unblockedBy: "PLAT-812",
      reason: "PLAT-812 moved to Done on 6 Oct",
      notified: true,
    },
  ],
  threads: [
    {
      id: "t1",
      summary: "Vendor asks",
      sender: "Dana",
      proposals: 2,
      questions: 1,
      since: "2026-10-05T09:00:00.000Z",
    },
  ],
  smallAskLabel: "small-ask",
  ...patch,
});

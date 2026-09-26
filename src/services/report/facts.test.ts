import { describe, expect, test } from "bun:test";
import {
  askText,
  buildRecapFacts,
  type RecapInputs,
  type RecapIssue,
  reportWindow,
  workingDays,
} from "./facts";

const SINCE = "2026-09-24T00:00:00.000Z";
const i = (key: string, p: Partial<RecapIssue> = {}): RecapIssue => ({
  key,
  summary: key,
  issueType: "Story",
  isSubtask: false,
  status: "In Progress",
  statusCategory: "indeterminate",
  assignee: "me",
  assigneeDisplay: "Me",
  reporter: "tom",
  reporterDisplay: "Tom",
  epicKey: null,
  sprint: "PAY 15",
  storyPoints: null,
  dueDate: null,
  created: "2026-09-01T00:00:00.000Z",
  updated: "2026-09-20T00:00:00.000Z",
  resolved: null,
  blockedBy: [],
  ...p,
});

const inputs = (p: Partial<RecapInputs> = {}): RecapInputs => ({
  me: "me",
  since: SINCE,
  until: "2026-09-26T09:00:00.000Z",
  today: "2026-09-26",
  tracked: new Set(),
  activeSprints: new Set(["PAY 15"]),
  sprint: { name: "PAY 15", start: "2026-09-15", end: "2026-09-28" },
  focus: [],
  issues: [],
  comments: [],
  history: new Map(),
  dependencies: [],
  asks: [],
  ...p,
});

const groups = (f: ReturnType<typeof buildRecapFacts>) =>
  Object.fromEntries(
    ["done", "new", "blocked", "in_progress", "changed", "next"].map((g) => [
      g,
      f.tickets.filter((t) => t.group === g).map((t) => t.key),
    ]),
  );

const base = inputs({
  focus: ["TODO-2", "TODO-1"],
  issues: [
    i("EP-1", { issueType: "Epic", summary: "Refund accuracy", sprint: null }),
    i("DONE-1", {
      statusCategory: "done",
      status: "Done",
      resolved: "2026-09-25T10:00:00.000Z",
      storyPoints: 5,
      epicKey: "EP-1",
    }),
    i("DONE-OLD", {
      statusCategory: "done",
      status: "Done",
      resolved: "2026-09-10T00:00:00.000Z",
      epicKey: "EP-1",
    }),
    i("NEW-1", { statusCategory: "new", status: "To Do", created: "2026-09-25T08:00:00.000Z" }),
    i("ASSIGNED-1", { statusCategory: "new", status: "To Do" }),
    i("BLK-1", { storyPoints: 3 }),
    i("WIP-1", { updated: "2026-09-25T00:00:00.000Z", status: "In Review", storyPoints: 2 }),
    i("WIP-2", { dueDate: "2026-09-27", epicKey: "EP-1" }),
    i("OTHER-1", { assignee: "ana", reporter: "me" }),
    i("TODO-1", { statusCategory: "new", status: "To Do" }),
    i("TODO-2", { statusCategory: "new", status: "To Do" }),
    i("BACKLOG-1", { statusCategory: "new", status: "To Do", sprint: null }),
    i("NOT-MINE", { assignee: "ana" }),
  ],
  comments: [
    {
      issueKey: "OTHER-1",
      author: "ana",
      authorDisplay: "Ana",
      created: "2026-09-25T09:00:00.000Z",
      body: "Deployed   to staging.",
    },
    {
      issueKey: "WIP-1",
      author: "me",
      authorDisplay: "Me",
      created: "2026-09-25T09:00:00.000Z",
      body: "Started.",
    },
  ],
  history: new Map([
    [
      "ASSIGNED-1",
      [
        {
          at: "2026-09-24T15:00:00.000Z",
          author: "tom",
          authorDisplay: "Tom",
          items: [{ field: "assignee", from: null, to: "Me", toId: "me" }],
        },
      ],
    ],
    [
      "WIP-1",
      [
        {
          at: "2026-09-25T08:00:00.000Z",
          author: "me",
          authorDisplay: "Me",
          items: [{ field: "status", from: "In Progress", to: "In Review", toId: "3" }],
        },
      ],
    ],
  ]),
  dependencies: [
    {
      issueKey: "BLK-1",
      label: "Firewall rule",
      owner: "Network",
      externalRef: "OPS-77",
      status: "blocked",
      requestedAt: "2026-09-22",
      expectedAt: "2026-09-23",
      nextFollowupAt: "2026-09-26",
      followups: [{ at: "2026-09-24T10:15:00.000Z", channel: "teams", summary: "No reply" }],
    },
  ],
  asks: [{ key: "DONE-1", who: "Ana", what: "Ana mentioned you", at: "2026-09-25T12:00:00.000Z" }],
});

describe("buildRecapFacts", () => {
  test("groups my work: done, new, blocked, in progress, changed, next", () => {
    expect(groups(buildRecapFacts(base))).toEqual({
      done: ["DONE-1"],
      new: ["NEW-1", "ASSIGNED-1"],
      blocked: ["BLK-1"],
      in_progress: ["WIP-1", "WIP-2"],
      changed: ["OTHER-1"],
      next: ["TODO-2", "TODO-1"],
    });
  });

  test("each ticket carries its timeline, dependencies, epic and asks", () => {
    const f = buildRecapFacts(base);
    const t = (k: string) => f.tickets.find((x) => x.key === k);
    expect(t("WIP-1")?.events.map((e) => [e.kind, e.by, e.text])).toEqual([
      ["status", "you", "In Progress -> In Review"],
      ["comment", "you", "Started."],
    ]);
    expect(t("ASSIGNED-1")?.events.map((e) => e.text)).toEqual(["Assigned to you"]);
    expect(t("NEW-1")?.events.map((e) => [e.by, e.text])).toEqual([
      ["Tom", "Created and assigned to you"],
    ]);
    // No history for DONE-1: the resolution date stands in.
    expect(t("DONE-1")?.events.map((e) => e.kind)).toEqual(["resolved"]);
    expect(t("DONE-1")?.epic).toEqual({ key: "EP-1", name: "Refund accuracy" });
    expect(t("DONE-1")?.waitingOnMe).toBe("Ana: Ana mentioned you");
    expect(t("OTHER-1")?.comments).toEqual([
      { by: "Ana", at: "2026-09-25T09:00:00.000Z", text: "Deployed to staging." },
    ]);
    const blk = t("BLK-1");
    expect(blk?.dependencies[0]).toMatchObject({
      owner: "Network",
      externalRef: "OPS-77",
      overdueDays: 3,
      followupDue: true,
      lastFollowup: { channel: "teams" },
    });
    expect(blk?.events.map((e) => e.text)).toEqual([
      "Chased Network about OPS-77 (teams): No reply",
    ]);
  });

  test("sprint health, epic progress and risks come from code", () => {
    const f = buildRecapFacts(base);
    expect(f.sprint).toEqual({
      name: "PAY 15",
      endsOn: "2026-09-28",
      day: 9,
      days: 10,
      pointsDone: 5,
      pointsTotal: 10,
      pointsInReview: 2,
      pointsBlocked: 3,
      unestimated: expect.arrayContaining(["NEW-1", "WIP-2", "TODO-1"]),
    });
    expect(f.epics).toEqual([{ key: "EP-1", name: "Refund accuracy", done: 2, total: 3 }]);
    expect(f.risks).toEqual([
      "BLK-1 (3 pts) is blocked on OPS-77 (Network) for 4 days; the sprint ends Mon 28 Sep.",
      "WIP-2 is due 27 Sep and in In Progress.",
      "5 of 10 points done with 1 working day left in PAY 15.",
    ]);
    expect(f.stats).toEqual({ done: 1, pointsDone: 5, inProgress: 2, new: 2, comments: 2 });
  });

  test("tracked epics bring their tickets in", () => {
    const f = buildRecapFacts(
      inputs({
        tracked: new Set(["EP-9"]),
        issues: [
          i("T-1", {
            assignee: "ana",
            epicKey: "EP-9",
            statusCategory: "done",
            status: "Done",
            resolved: "2026-09-25T00:00:00.000Z",
          }),
        ],
      }),
    );
    expect(groups(f).done).toEqual(["T-1"]);
  });
});

describe("asks", () => {
  test("a question from someone else in the period is quoted; older asks follow", () => {
    const f = buildRecapFacts({
      ...base,
      comments: [
        ...base.comments,
        {
          issueKey: "DONE-1",
          author: "ana",
          authorDisplay: "Ana",
          created: "2026-09-25T13:00:00.000Z",
          body: "Verified on staging. Can we ship this in the 1 October release?",
        },
      ],
      asks: [{ key: "WIP-2", who: "Tom", what: "Any update?", at: "2026-09-20T09:00:00.000Z" }],
    });
    expect(f.asks).toEqual([
      { key: "WIP-2", who: "Tom", what: "Any update?", at: "2026-09-20T09:00:00.000Z" },
      {
        key: "DONE-1",
        who: "Ana",
        what: "Can we ship this in the 1 October release?",
        at: "2026-09-25T13:00:00.000Z",
      },
    ]);
    expect(f.tickets.find((t) => t.key === "DONE-1")?.waitingOnMe).toBe(
      "Ana: Can we ship this in the 1 October release?",
    );
  });

  test("askText takes the last question, or the first words", () => {
    expect(
      askText("Looks good. Why UTF-8? Can we ship the BOM change in the October release?\nThanks"),
    ).toBe("Can we ship the BOM change in the October release?");
    expect(askText("Excel users need a BOM. Can you add it?")).toBe(
      "Excel users need a BOM. Can you add it?",
    );
    expect(askText("Deployed   to staging.")).toBe("Deployed to staging.");
  });
});

describe("periods", () => {
  test("last working day skips the weekend", () => {
    const monday = new Date(2026, 8, 28, 9, 0);
    const w = reportWindow({ kind: "workday" }, monday);
    expect(new Date(w.since)).toEqual(new Date(2026, 8, 25, 0, 0));
    expect(w.label).toBe("Since Friday");
    expect(reportWindow({ kind: "workday" }, new Date(2026, 8, 24, 9, 0)).label).toBe(
      "Since yesterday",
    );
  });

  test("days count back from local midnight; working days skip weekends", () => {
    const w = reportWindow({ kind: "days", days: 7 }, new Date(2026, 8, 24, 15, 0));
    expect(new Date(w.since)).toEqual(new Date(2026, 8, 17, 0, 0));
    expect(w.label).toBe("Last 7 days");
    expect(workingDays("2026-09-15", "2026-09-28")).toBe(10);
    expect(workingDays("2026-09-26", "2026-09-27")).toBe(0);
  });
});

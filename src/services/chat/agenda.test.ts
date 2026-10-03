import { describe, expect, test } from "bun:test";
import { pendingDecisions, weekAhead } from "./agenda";

describe("pendingDecisions", () => {
  test("groups the Inbox by thread, oldest wait first, and lists unsent drafts", () => {
    const r = pendingDecisions(
      [
        {
          inboxItemId: "a",
          threadSummary: "Cancel PAY-2",
          receivedAt: "2026-09-25T09:00:00Z",
          kind: "transition_issue",
          description: "Move PAY-2 to Done",
          question: null,
          createdAt: "2026-09-25T09:00:00Z",
        },
        {
          inboxItemId: "b",
          threadSummary: "Vendor delay",
          receivedAt: "2026-09-21T09:00:00Z",
          kind: "needs_clarification",
          description: "Ask",
          question: "Which vendor?",
          createdAt: "2026-09-21T09:00:00Z",
        },
      ],
      [{ to: "Ana", issueKeys: ["PAY-4"], updatedAt: "2026-09-27T10:00:00Z" }],
      "2026-09-28",
    );
    expect(r.inbox).toEqual([
      {
        thread: "Vendor delay",
        inboxItemId: "b",
        waitingDays: 7,
        approve: [],
        questions: ["Which vendor?"],
      },
      {
        thread: "Cancel PAY-2",
        inboxItemId: "a",
        waitingDays: 3,
        approve: ["Move PAY-2 to Done"],
        questions: [],
      },
    ]);
    expect(r.unsentDrafts).toEqual([{ to: "Ana", about: ["PAY-4"], days: 1 }]);
  });
});

describe("weekAhead", () => {
  test("puts the next seven days in date order and leaves later ones out", () => {
    const r = weekAhead({
      today: "2026-09-28",
      dueSoon: [
        { key: "PAY-4", summary: "Refunds", dueDate: "2026-09-30", status: "In Progress" },
        { key: "PAY-9", summary: "Late", dueDate: "2026-09-26", status: "To Do" },
      ],
      dependencies: [
        {
          issueKey: "PAY-2",
          label: "Firewall rule",
          owner: "Network",
          expectedAt: "2026-10-01",
          nextFollowupAt: "2026-09-29",
        },
        {
          issueKey: "PAY-3",
          label: "Sample",
          owner: "Dana",
          expectedAt: "2026-10-20",
          nextFollowupAt: null,
        },
      ],
      sprint: { name: "PAY 15", end: "2026-10-02", total: 21, done: 13 },
      atRisk: [],
    });
    expect(r.events.map((e) => [e.date, e.what])).toEqual([
      ["2026-09-26", "PAY-9 Late due (2 days overdue) [To Do]"],
      ["2026-09-29", "Follow up with Network about Firewall rule (PAY-2)"],
      ["2026-09-30", "PAY-4 Refunds due [In Progress]"],
      ["2026-10-01", "Network expected to deliver Firewall rule for PAY-2"],
      [
        "2026-10-02",
        "Sprint PAY 15 ends: 13 of 21 points done; plan the next sprint in Sprint > Plan",
      ],
    ]);
  });
});

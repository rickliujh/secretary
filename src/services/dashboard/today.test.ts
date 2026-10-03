import { describe, expect, test } from "bun:test";
import { DEFAULT_WEIGHTS } from "@/services/settings/schema";
import {
  ask,
  blockedBy,
  comment,
  issue,
  mixedInputs,
  NOW,
  TODAY,
  wait,
} from "@/test/today-fixture";
import {
  agoLabel,
  buildToday,
  dueLabel,
  groupThreads,
  type Today,
  type TodayInputs,
} from "./today";

const build = (p: Partial<TodayInputs> = {}, today = TODAY, now = NOW) =>
  buildToday(mixedInputs(p), DEFAULT_WEIGHTS, today, now);

const keyOf = (r: Today["yourMove"][number] | Today["theirMove"][number]) =>
  r.kind === "thread"
    ? `thread:${r.thread.id}`
    : r.kind === "wait"
      ? `wait:${r.dependency.id}`
      : r.issue.key;

describe("buildToday over a mixed snapshot", () => {
  const t = build();

  test("Your move: woken first, then small asks by due date then age, comments, Inbox threads", () => {
    expect(t.yourMove.map((r) => [r.kind, keyOf(r), r.reason])).toEqual([
      ["woken", "WOKE-1", "PLAT-812 moved to Done on 6 Oct"],
      ["ask", "ASK-1", "due Friday, asked by Priya Shah 3 days ago"],
      ["ask", "ASK-2", "added 17 days ago"],
      ["comment", "ASK-6", "Dana commented"],
      ["comment", "CMT-1", "Ana commented"],
      ["thread", "thread:t1", "2 to approve, 1 question, waiting 2 days"],
    ]);
  });

  test("Their move: overdue, follow-up due, owner back, the rest, blocked tickets, then sleeping ones, soonest to wake first", () => {
    expect(t.theirMove.map((r) => [keyOf(r), r.reason])).toEqual([
      ["wait:d-over", "6 days overdue"],
      ["wait:d-follow", "follow-up 1 day late"],
      ["wait:d-back", "Bob is back"],
      ["wait:d-ask", "expected 20 Oct"],
      ["ASK-4", "blocked by OPS-7"],
      ["BLK-1", "blocked by OPS-8"],
      ["wait:d-snz", "ticket snoozed until 9 Oct"],
      ["wait:d-asleep", "Carl is away until 14 Oct"],
      ["SNZ-1", "blocked by OPS-9; snoozed until 9 Oct"],
    ]);
  });

  test("Sprint work: Top focus of what is left, then due-soon and at-risk tickets as badges", () => {
    expect(t.sprintWork.map((r) => [r.issue.key, r.inFocus, r.daysLeft, r.risks])).toEqual([
      ["SPR-1", true, null, ["Waiting on d-over label (6d overdue)"]],
      ["SPR-2", true, null, []],
      ["LATE-1", false, -2, ["2 days past due"]],
    ]);
    expect(t.sprintWork[2]?.reason).toBe("2 days past due");
    expect(t.sprintWork[0]?.reason).toBe("Waiting on d-over label, 6 days overdue");
  });

  test("a ticket is in one list only; waits are rows of their own", () => {
    const tickets = [
      ...t.yourMove.filter((r) => r.kind !== "thread").map(keyOf),
      ...t.theirMove.filter((r) => r.kind === "blocked").map(keyOf),
      ...t.sprintWork.map((r) => r.issue.key),
    ];
    expect(new Set(tickets).size).toBe(tickets.length);
    // Never listed: an ask with a wait (its wait stands for it), a snoozed ask,
    // someone else's ask, and a closed one.
    for (const k of ["ASK-3", "ASK-5", "ASK-7", "ASK-8"]) expect(tickets).not.toContain(k);
  });

  test("open small asks with where each stands, for the chat", () => {
    expect(t.smallAsks.home).toBe(true);
    expect(Object.fromEntries(t.smallAsks.open.map((a) => [a.issue.key, a.state]))).toEqual({
      "ASK-1": "your move",
      "ASK-2": "your move",
      "ASK-3": "waiting on Acme (d-ask label)",
      "ASK-4": "blocked by OPS-7",
      "ASK-5": "snoozed until 9 Oct",
      "ASK-6": "your move: Dana commented",
    });
  });

  test("the user's active sprint end, for snoozing until after the sprint", () => {
    expect(t.sprintEnd).toBe("2026-10-09");
    expect(t.focus).toEqual({ mode: "sprint", sprints: ["Payments 15"], endsOn: "2026-10-09" });
  });
});

describe("precedence", () => {
  test("woken beats a new comment; a comment beats a blocker; a blocker beats an ask", () => {
    const t = build({
      issues: [
        issue("WOKE-1"),
        issue("CB-1", { links: blockedBy("OPS-1") }),
        ask("AB-1", { links: blockedBy("OPS-2") }),
      ],
      comments: [comment("WOKE-1", NOW), comment("CB-1", NOW)],
      dependencies: [],
      threads: [],
    });
    expect(t.yourMove.map((r) => [r.kind, keyOf(r)])).toEqual([
      ["woken", "WOKE-1"],
      ["comment", "CB-1"],
    ]);
    expect(t.theirMove.map(keyOf)).toEqual(["AB-1"]);
    expect(t.sprintWork).toEqual([]);
  });

  test("a viewed comment no longer counts, so the ticket falls back to its own place", () => {
    const t = build({
      issues: [issue("CB-1", { links: blockedBy("OPS-1"), lastViewedAt: NOW })],
      comments: [comment("CB-1", "2026-10-07T08:00:00.000Z")],
      dependencies: [],
      woken: [],
      threads: [],
    });
    expect(t.yourMove).toEqual([]);
    expect(t.theirMove.map(keyOf)).toEqual(["CB-1"]);
  });

  test("a blocker that is done is no blocker: the fresh state wins over the link's copy (D45)", () => {
    const t = build({
      issues: [issue("X-1", { links: blockedBy("OPS-1") })],
      blockers: { "OPS-1": { statusCategory: "done" } },
      dependencies: [],
      comments: [],
      woken: [],
      threads: [],
    });
    expect(t.theirMove).toEqual([]);
    expect(t.sprintWork.map((r) => r.issue.key)).toEqual(["X-1"]);
  });

  test("small asks are never Sprint work, even in the sprint", () => {
    const t = build({
      issues: [ask("A-1"), issue("S-1")],
      dependencies: [],
      comments: [],
      woken: [],
    });
    expect(t.sprintWork.map((r) => r.issue.key)).toEqual(["S-1"]);
    expect(t.yourMove.filter((r) => r.kind === "ask").map(keyOf)).toEqual(["A-1"]);
  });
});

describe("waits", () => {
  const only = (deps: TodayInputs["dependencies"], today = TODAY) =>
    build(
      { dependencies: deps, issues: [issue("W-1")], comments: [], woken: [], threads: [] },
      today,
      `${today}T09:00:00.000Z`,
    ).theirMove.map((r) => (r.kind === "wait" ? [r.dependency.id, r.state] : [r.issue.key]));

  test("an owner away sleeps last; from the first working day back the wait is due with the reason (D47)", () => {
    const deps = [
      wait("away", "W-1", {
        ownerName: "Bob",
        ownerAway: { name: "Bob", awayUntil: "2026-10-09" },
      }),
      wait("open", "W-1", { expectedAt: "2026-10-30" }),
    ];
    expect(only(deps)).toEqual([
      ["open", "open"],
      ["away", "asleep"],
    ]);
    // Friday the 9th is the last day away; Monday the 12th he is back.
    expect(only(deps, "2026-10-12")).toEqual([
      ["away", "back"],
      ["open", "open"],
    ]);
  });

  test("overdue beats owner back; the most overdue first", () => {
    expect(
      only([
        wait("a", "W-1", { expectedAt: "2026-10-05" }),
        wait("b", "W-1", { expectedAt: "2026-10-01" }),
        wait("c", "W-1", {
          expectedAt: "2026-10-06",
          ownerAway: { name: "Bob", awayUntil: "2026-10-05" },
        }),
      ]),
    ).toEqual([
      ["b", "overdue"],
      ["a", "overdue"],
      ["c", "overdue"],
    ]);
  });
});

describe("without a small-asks home", () => {
  test("Your move still lists woken tickets, comments and Inbox threads; asks are ordinary work", () => {
    const t = build({ smallAskLabel: null });
    expect(t.smallAsks).toEqual({ home: false, open: [] });
    expect(t.yourMove.map((r) => r.kind)).toEqual(["woken", "comment", "comment", "thread"]);
    expect(t.sprintWork.map((r) => r.issue.key)).toContain("ASK-1");
  });

  test("nothing at all gives three empty lists", () => {
    const t = build({ issues: [], dependencies: [], comments: [], woken: [], threads: [] });
    expect([t.yourMove, t.theirMove, t.sprintWork]).toEqual([[], [], []]);
  });
});

describe("labels", () => {
  test("due dates and ages in a few words", () => {
    expect(dueLabel("2026-10-07", TODAY)).toBe("due today");
    expect(dueLabel("2026-10-08", TODAY)).toBe("due tomorrow");
    expect(dueLabel("2026-10-09", TODAY)).toBe("due Friday");
    expect(dueLabel("2026-10-20", TODAY)).toBe("due 20 Oct");
    expect(dueLabel("2026-10-06", TODAY)).toBe("1 day late");
    expect(agoLabel("2026-10-07T01:00:00.000Z", TODAY)).toBe("today");
    expect(agoLabel("2026-10-06", TODAY)).toBe("yesterday");
    expect(agoLabel("2026-10-01", TODAY)).toBe("6 days ago");
  });

  test("Inbox threads are grouped from pending proposals, questions counted apart", () => {
    expect(
      groupThreads([
        {
          inboxItemId: "b",
          kind: "add_comment",
          createdAt: "2026-10-06",
          summary: "B",
          sender: null,
        },
        {
          inboxItemId: "a",
          kind: "create_issue",
          createdAt: "2026-10-05",
          summary: "A",
          sender: "Dana",
        },
        {
          inboxItemId: "a",
          kind: "needs_clarification",
          createdAt: "2026-10-04",
          summary: "A",
          sender: "Dana",
        },
      ]),
    ).toEqual([
      { id: "a", summary: "A", sender: "Dana", proposals: 1, questions: 1, since: "2026-10-04" },
      { id: "b", summary: "B", sender: null, proposals: 1, questions: 0, since: "2026-10-06" },
    ]);
  });
});

test("2,000 issues build well inside the 1 second budget (FR-12 AC)", () => {
  const issues = Array.from({ length: 2000 }, (_, n) =>
    issue(`BIG-${n}`, {
      assignee: n % 2 ? "me" : "ana",
      labels: n % 9 ? [] : ["small-ask"],
      sprint: n % 3 ? "Payments 15" : null,
      dueDate: n % 5 ? null : "2026-10-09",
      links: n % 7 ? [] : blockedBy("OPS-7"),
      updated: n % 4 ? "2026-10-06T00:00:00.000Z" : "2026-08-01T00:00:00.000Z",
    }),
  );
  const comments = issues.slice(0, 500).map((i) => comment(i.key, NOW));
  const dependencies = issues
    .slice(0, 300)
    .map((i, n) => wait(`d${n}`, i.key, { expectedAt: n % 2 ? "2026-10-01" : "2026-10-20" }));
  const started = performance.now();
  const t = build({ issues, comments, dependencies, woken: [] });
  expect(performance.now() - started).toBeLessThan(150);
  expect(t.sprintWork.filter((r) => r.inFocus)).toHaveLength(10);
  expect(t.yourMove.length).toBeGreaterThan(0);
  expect(t.theirMove.length).toBeGreaterThan(300);
});

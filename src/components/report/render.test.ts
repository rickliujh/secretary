import { describe, expect, test } from "bun:test";
import { REPORT_STYLES, type Report, type ReportTicket } from "@/services/report";
import { markdownToText } from "./format";
import { esc, renderReport } from "./render";

// Local times (no zone), so the expected dates and clocks hold in any time zone.
const ticket = (
  t: Partial<ReportTicket> & Pick<ReportTicket, "key" | "summary">,
): ReportTicket => ({
  status: "To Do",
  statusCategory: "new",
  points: null,
  group: "changed",
  epic: null,
  dueDate: null,
  notes: [],
  events: [],
  dependencies: [],
  waitingOnMe: null,
  happened: "",
  next: "",
  ...t,
});

const refunds = { key: "PAY-300", name: "Refund accuracy" };
const ledger = { key: "PAY-350", name: "Ledger export" };
const bank = { key: "PAY-380", name: "Bank connectivity" };

const report: Report = {
  generatedAt: "2026-09-25T16:30:00",
  since: "2026-09-18T00:00:00",
  until: "2026-09-25T16:30:00",
  periodLabel: "Last 7 days",
  scope: "mine",
  talkTrack:
    "Finished the refund rounding fix (PAY-412), QA passed. Ledger export (PAY-398) is in review; one change left from Tom on CSV encoding. Bank-file retry (PAY-420) is still blocked on the firewall rule; I chase Network today.",
  headline:
    "Refunds work is done and verified; ledger export is close; bank-file retry is the one risk this sprint.",
  tickets: [
    ticket({
      key: "PAY-431",
      summary: "Duplicate payout alert",
      group: "new",
      points: 2,
      dueDate: "2026-10-02",
      events: [
        { at: "2026-09-24T09:40:00", kind: "created", by: "Tom", text: "Created" },
        { at: "2026-09-24T09:40:00", kind: "assigned", by: "Tom", text: "Assigned to you" },
      ],
      next: "Start the investigation",
    }),
    ticket({
      key: "PAY-398",
      summary: "Ledger export",
      status: "In Review",
      statusCategory: "indeterminate",
      points: 5,
      group: "in_progress",
      epic: ledger,
      events: [
        {
          at: "2026-09-24T11:02:00",
          kind: "status",
          by: "you",
          text: "In Progress -> In Review",
        },
        {
          at: "2026-09-24T14:30:00",
          kind: "comment",
          by: "Tom",
          text: "wants UTF-8 with BOM for Excel users",
        },
      ],
      happened: "Tom asked for UTF-8 with BOM for Excel",
      next: "Add the BOM and a test, reply to Tom, back to review today",
    }),
    ticket({
      key: "PAY-412",
      summary: "Refund rounding",
      status: "Done",
      statusCategory: "done",
      points: 3,
      group: "done",
      epic: refunds,
      events: [
        {
          at: "2026-09-24T15:20:00",
          kind: "comment",
          by: "Ana",
          text: "verified on staging, all 4 cases pass",
        },
        { at: "2026-09-24T16:10:00", kind: "status", by: "you", text: "In Review -> Done" },
      ],
      happened: "Ana verified all 4 cases on staging.",
      waitingOnMe: "Ana asked whether it ships in the 1 Oct release",
    }),
    ticket({
      key: "PAY-409",
      summary: "Currency cutoff",
      status: "Done",
      statusCategory: "done",
      points: 5,
      group: "done",
      epic: refunds,
      events: [
        { at: "2026-09-22T10:05:00", kind: "status", by: "you", text: "In Progress -> Done" },
      ],
    }),
    ticket({
      key: "PAY-420",
      summary: "Bank-file retry",
      status: "In Progress",
      statusCategory: "indeterminate",
      points: 3,
      group: "blocked",
      epic: bank,
      notes: ["Blocked by OPS-77"],
      events: [
        {
          at: "2026-09-23T10:15:00",
          kind: "followup",
          by: "you",
          text: "Chased Network about OPS-77",
        },
      ],
      dependencies: [
        {
          label: "firewall rule",
          owner: "Network (Priya)",
          externalRef: "OPS-77",
          status: "blocked",
          since: "2026-09-22",
          expectedAt: "2026-09-23",
          overdueDays: 3,
          lastFollowup: { at: "2026-09-23T10:15:00", channel: "Teams", summary: null },
          nextFollowupAt: "2026-09-25",
          followupDue: true,
        },
      ],
      next: "Chase Network again today",
    }),
    ticket({
      key: "PAY-433",
      summary: "Payout report filters",
      group: "new",
      epic: ledger,
      events: [{ at: "2026-09-25T13:00:00", kind: "created", by: "Ana", text: "Created" }],
    }),
  ],
  epics: [
    { ...refunds, done: 4, total: 5 },
    { ...ledger, done: 1, total: 3 },
    { ...bank, done: 0, total: 2 },
  ],
  sprint: {
    name: "Payments 15",
    endsOn: "2026-09-28",
    day: 9,
    days: 10,
    pointsDone: 13,
    pointsTotal: 21,
    pointsInReview: 5,
    pointsBlocked: 3,
    unestimated: ["PAY-433"],
  },
  risks: ["PAY-420 (3 pts) misses the sprint unless OPS-77 lands by Mon 28 Sep."],
  asks: [
    { key: "PAY-412", who: "Ana", what: "ship in the 1 Oct release?", at: "2026-09-24T17:00:00" },
  ],
  stats: { done: 2, pointsDone: 8, inProgress: 2, new: 2, comments: 2 },
  historyMissing: [],
  model: "glm-5.3-flash",
};

const empty: Report = {
  ...report,
  talkTrack: "",
  headline: "",
  tickets: [],
  epics: [],
  sprint: null,
  risks: [],
  asks: [],
};

describe("talk track", () => {
  test("has the script to read out, then the facts per ticket in group order", () => {
    expect(renderReport(report, "talk_track")).toBe(
      `## Update since Fri 18 Sep · Payments 15 (ends Mon 28 Sep)

### Say this

Finished the refund rounding fix (PAY-412), QA passed. Ledger export (PAY-398) is in review; one change left from Tom on CSV encoding. Bank-file retry (PAY-420) is still blocked on the firewall rule; I chase Network today.

### Details

**PAY-412 Refund rounding** · DONE · 3 pts
- In Review -> Done Thu 16:10 (me)
- Ana verified all 4 cases on staging.
- Waiting on me: Ana asked whether it ships in the 1 Oct release

**PAY-409 Currency cutoff** · DONE · 5 pts
- In Progress -> Done Tue 10:05 (me)

**PAY-398 Ledger export** · IN REVIEW · 5 pts
- In Progress -> In Review Thu 11:02 (me)
- Tom asked for UTF-8 with BOM for Excel
- Next: Add the BOM and a test, reply to Tom, back to review today

**PAY-420 Bank-file retry** · BLOCKED · 3 pts
- Blocked on Network (Priya): firewall rule OPS-77
- Since Tue 22 Sep (3 days), expected Wed 23 Sep, 3 days overdue
- Last chased Wed 23 Sep on Teams; follow-up due today
- Next: Chase Network again today

**PAY-431 Duplicate payout alert** · NEW · due 2 Oct · 2 pts
- Created Thu 09:40 (Tom)
- Assigned to me Thu 09:40 (Tom)
- Next: Start the investigation

**PAY-433 Payout report filters** · NEW
- Created Fri 13:00 (Ana)

### Waiting on me

- Ana on PAY-412: ship in the 1 Oct release? (1 day)

### Risks

- PAY-420 (3 pts) misses the sprint unless OPS-77 lands by Mon 28 Sep.

### Sprint Payments 15

- 13/21 pts done · 5 in review · 3 blocked
- 1 ticket unestimated (PAY-433)`,
    );
  });
});

describe("stand-up", () => {
  test("says what moved, what is next and what blocks", () => {
    expect(renderReport(report, "standup")).toBe(
      `## Stand-up · Fri 25 Sep (since 18 Sep)

### Last 7 days

- PAY-412 Refund rounding: moved to Done at Thu 16:10; Ana verified all 4 cases on staging. (3 pts)
- PAY-409 Currency cutoff: moved to Done at Tue 10:05. (5 pts)
- PAY-398 Ledger export: moved to In Review at Thu 11:02; Tom asked for UTF-8 with BOM for Excel.
- PAY-420 Bank-file retry: chased Network about OPS-77.
- PAY-431 Duplicate payout alert: created by Tom; assigned to me.
- PAY-433 Payout report filters: created by Ana.

### Today

- PAY-398: Add the BOM and a test, reply to Tom, back to review today.
- PAY-420: Chase Network again today.
- PAY-431 (new from Tom, due 2 Oct, 2 pts): Start the investigation.
- Answer Ana on PAY-412: ship in the 1 Oct release?

### Blockers

- PAY-420 waits on OPS-77 firewall rule, owner Network (Priya). Open 3 days, 3 days past expected date. Follow-up due today.

### Sprint

Payments 15: 13 of 21 pts done, ends Mon 28 Sep.

### Risks

- PAY-420 (3 pts) misses the sprint unless OPS-77 lands by Mon 28 Sep.`,
    );
  });

  test("calls the period Yesterday, shows clock times and introduces tickets not yet mentioned", () => {
    const md = renderReport(
      {
        ...report,
        since: "2026-09-24T00:00:00",
        until: "2026-09-25T09:00:00",
        periodLabel: "Since yesterday",
        tickets: report.tickets.map((t) => (t.key === "PAY-431" ? { ...t, events: [] } : t)),
      },
      "standup",
    );
    expect(md).toStartWith("## Stand-up · Fri 25 Sep (since Thu)\n\n### Yesterday\n\n");
    expect(md).toContain("- PAY-412 Refund rounding: moved to Done at 16:10;");
    expect(md).toContain(
      "- PAY-431 Duplicate payout alert (new, due 2 Oct, 2 pts): Start the investigation.",
    );
  });
});

describe("catch-up by epic", () => {
  test("has the headline, sprint health, tickets under their epics, asks and new work", () => {
    expect(renderReport(report, "by_epic")).toBe(
      `## Catch-up · Last 7 days (18–25 Sep)

### Headline

Refunds work is done and verified; ledger export is close; bank-file retry is the one risk this sprint.

### Sprint health: Payments 15 · day 9 of 10

- Points: 13/21 pts done (62%) · 5 in review · 3 blocked
- Done this period: 2 tickets, 8 pts
- Unestimated: PAY-433

### By epic

**PAY-300 Refund accuracy** · 4/5 done
- ✓ PAY-412 Refund rounding: Ana verified all 4 cases on staging.
- ✓ PAY-409 Currency cutoff

**PAY-350 Ledger export** · 1/3 done
- ◐ PAY-398 Ledger export · In Review: Tom asked for UTF-8 with BOM for Excel
- · PAY-433 Payout report filters · To Do

**PAY-380 Bank connectivity** · 0/2 done
- ⚠ PAY-420 Bank-file retry · In Progress: blocked 3 days on OPS-77 (Network (Priya)); follow-up due today

**No epic**
- · PAY-431 Duplicate payout alert · To Do: Start the investigation

### Risks

- PAY-420 (3 pts) misses the sprint unless OPS-77 lands by Mon 28 Sep.

### Decisions and asks

- Ana on PAY-412: ship in the 1 Oct release? (open 1 day)

### New this period

- PAY-431 Duplicate payout alert from Tom (due 2 Oct)
- PAY-433 Payout report filters from Ana`,
    );
  });
});

describe("timeline", () => {
  test("lists events newest day first, clock order within a day, then what is open", () => {
    expect(renderReport(report, "timeline")).toBe(
      `## Last 7 days · 18–25 Sep

### Fri 25 Sep

- 13:00 PAY-433 created (Ana)

### Thu 24 Sep

- 09:40 PAY-431 created (Tom)
- 09:40 PAY-431 assigned to me (Tom)
- 11:02 PAY-398 In Progress -> In Review (me)
- 14:30 PAY-398 Tom: wants UTF-8 with BOM for Excel users
- 15:20 PAY-412 Ana: verified on staging, all 4 cases pass
- 16:10 PAY-412 In Review -> Done (me)

### Wed 23 Sep

- 10:15 PAY-420 follow-up: Chased Network about OPS-77 (me)

### Tue 22 Sep

- 10:05 PAY-409 In Progress -> Done (me)

### Open now

- ◐ PAY-398 Ledger export · In Review, 5 pts: Add the BOM and a test, reply to Tom, back to review today
- ⚠ PAY-420 Bank-file retry · In Progress, 3 pts: blocked 3 days on OPS-77 (Network (Priya)); follow-up due today
- · PAY-431 Duplicate payout alert · To Do, due 2 Oct, 2 pts: Start the investigation
- · PAY-433 Payout report filters · To Do

### Waiting on me

- Ana on PAY-412: ship in the 1 Oct release?

### Risks

- PAY-420 (3 pts) misses the sprint unless OPS-77 lands by Mon 28 Sep.

### Sprint

Payments 15: 13/21 pts · ends Mon 28 Sep`,
    );
  });
});

describe("every style", () => {
  test("says there was no activity instead of leaving empty headings", () => {
    for (const style of REPORT_STYLES) {
      const md = renderReport(empty, style);
      expect(md).toContain("No ticket activity in this period.");
      expect(md.match(/^#+ /gm)).toHaveLength(1);
      expect(md).not.toMatch(/undefined|null|NaN/);
    }
  });

  test("never prints missing values", () => {
    const bare: Report = {
      ...report,
      sprint: report.sprint && {
        ...report.sprint,
        endsOn: null,
        day: null,
        days: null,
        unestimated: [],
      },
      tickets: report.tickets.map((t) => ({
        ...t,
        dependencies: t.dependencies.map((d) => ({
          ...d,
          externalRef: null,
          since: null,
          expectedAt: null,
          overdueDays: 0,
          lastFollowup: null,
          nextFollowupAt: null,
          followupDue: false,
        })),
      })),
    };
    for (const style of REPORT_STYLES) {
      const md = renderReport(bare, style);
      expect(md).not.toMatch(/undefined|null|NaN|\(\)|: $|: \n/m);
      expect(md).not.toMatch(/^### .*\n\n#/m);
    }
  });

  test("keeps ticket keys plain so the page can link them", () => {
    for (const style of REPORT_STYLES) {
      const md = renderReport(report, style);
      expect(md).toContain("PAY-412");
      expect(md).not.toMatch(/\[PAY-|`PAY-|PAY\\-/);
    }
  });

  test("reads as plain text with no Markdown syntax left", () => {
    const text = markdownToText(renderReport(report, "talk_track"));
    expect(text).toStartWith(
      "Update since Fri 18 Sep · Payments 15 (ends Mon 28 Sep)\n\nSay this\nFinished the refund",
    );
    expect(text).toContain(
      "PAY-412 Refund rounding · DONE · 3 pts\n• In Review -> Done Thu 16:10 (me)\n",
    );
    expect(text).not.toMatch(/\*\*|^#|\\/m);
  });
});

describe("escaping", () => {
  test("keeps text from Jira and the model literal", () => {
    expect(esc("Fix *all* the [links] in `code` <b>now</b>")).toBe(
      "Fix \\*all\\* the \\[links\\] in \\`code\\` \\<b>now\\</b>",
    );
    expect(esc("- not a list")).toBe("\\- not a list");
    expect(esc("# not a heading")).toBe("\\# not a heading");
    expect(esc("1. not a list")).toBe("1\\. not a list");
    expect(esc("snake_case stays, _emphasis_ does not")).toBe(
      "snake_case stays, \\_emphasis\\_ does not",
    );
    expect(esc("In Review -> Done, a < b")).toBe("In Review -> Done, a < b");
    expect(esc("two\n\nlines")).toBe("two lines");
  });

  test("a summary with Markdown syntax renders as its own text", () => {
    const md = renderReport(
      {
        ...empty,
        tickets: [ticket({ key: "PAY-1", summary: "Parse **bold** and _x_", happened: "x" })],
      },
      "standup",
    );
    expect(markdownToText(md)).toContain("• PAY-1 Parse **bold** and _x_: x.");
  });
});

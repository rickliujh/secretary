/**
 * The report groups by work item (Phase 24, D61 Reads): a ticket with no epic
 * sits under its work item in By epic and in the talk track's details, the
 * item's goal on the first line; the facts carry each ticket's item and the
 * prompt names it.
 */
import { describe, expect, test } from "bun:test";
import { buildReportPrompt } from "@/prompts/report";
import type { Report, ReportTicket } from "@/services/report";
import { buildRecapFacts, type RecapIssue } from "@/services/report/facts";
import { renderReport } from "./render";

const cert = {
  id: "w1",
  name: "Gateway cert",
  goal: "Renew the payment gateway cert before it expires",
};

const ticket = (
  t: Partial<ReportTicket> & Pick<ReportTicket, "key" | "summary">,
): ReportTicket => ({
  status: "In Progress",
  statusCategory: "indeterminate",
  points: null,
  group: "in_progress",
  epic: null,
  work: null,
  dueDate: null,
  notes: [],
  events: [],
  dependencies: [],
  waitingOnMe: null,
  happened: "",
  next: "",
  ...t,
});

const report: Report = {
  generatedAt: "2026-09-25T16:30:00",
  since: "2026-09-24T00:00:00",
  until: "2026-09-25T16:30:00",
  periodLabel: "Since yesterday",
  scope: "mine",
  sprintScope: [],
  talkTrack: "I'm renewing the gateway cert (PAY-12).",
  headline: "The cert is moving.",
  tickets: [
    ticket({ key: "PAY-12", summary: "Renew the cert", work: cert, next: "Install the cert" }),
    ticket({
      key: "PAY-13",
      summary: "Rotate the keys",
      group: "next",
      status: "To Do",
      statusCategory: "new",
      work: cert,
    }),
    ticket({
      key: "PAY-2",
      summary: "Ledger export",
      epic: { key: "PAY-1", name: "Billing" },
      work: cert,
    }),
    ticket({ key: "PAY-4", summary: "Refund rounding" }),
  ],
  epics: [{ key: "PAY-1", name: "Billing", done: 0, total: 2 }],
  sprint: null,
  risks: [],
  asks: [],
  stats: { done: 0, pointsDone: 0, inProgress: 2, new: 0, comments: 0 },
  historyMissing: [],
  model: null,
};

describe("the report by work item", () => {
  test("By epic: tickets with no epic under their item, the goal first", () => {
    const md = renderReport(report, "by_epic");
    expect(md).toContain(
      "**Gateway cert**\nGoal: Renew the payment gateway cert before it expires\n- ◐ PAY-12 Renew the cert · In Progress: Install the cert\n- · PAY-13 Rotate the keys · To Do",
    );
    // A ticket with an epic stays under the epic; one with neither is left over.
    expect(md).toContain("**PAY-1 Billing** · 0/2 done\n- ◐ PAY-2 Ledger export");
    expect(md).toContain("**No epic or work item**\n- ◐ PAY-4 Refund rounding");
  });

  test("talk track: the item's tickets together under its name and goal", () => {
    const md = renderReport(report, "talk_track");
    const at = md.indexOf("**Gateway cert**");
    expect(at).toBeGreaterThan(md.indexOf("### Details"));
    expect(md.slice(at)).toMatch(
      /^\*\*Gateway cert\*\*\n\nGoal: Renew the payment gateway cert before it expires\n\n\*\*PAY-12 Renew the cert\*\*/,
    );
    expect(md.indexOf("PAY-13 Rotate the keys")).toBeGreaterThan(at);
    expect(md.indexOf("**PAY-4 Refund rounding**")).toBeGreaterThan(md.indexOf("PAY-13"));
  });

  test("talk track: finished work still comes first; the item sits where its first ticket falls", () => {
    const md = renderReport(
      {
        ...report,
        tickets: [
          ...report.tickets,
          ticket({
            key: "PAY-9",
            summary: "Fix the export",
            group: "done",
            status: "Done",
            statusCategory: "done",
          }),
        ],
      },
      "talk_track",
    );
    expect(md.indexOf("**PAY-9 Fix the export**")).toBeLessThan(md.indexOf("**Gateway cert**"));
  });

  test("a report from before Phase 24 renders as it did", () => {
    const old: Report = {
      ...report,
      tickets: report.tickets.map(({ work: _, ...t }) => t as ReportTicket),
    };
    const md = renderReport(old, "by_epic");
    expect(md).not.toContain("Gateway cert");
    expect(md).toContain("**No epic**\n");
  });

  test("the facts carry each ticket's item, and the prompt names it with its goal", () => {
    const issue = (key: string): RecapIssue => ({
      key,
      summary: key,
      issueType: "Story",
      isSubtask: false,
      status: "In Progress",
      statusCategory: "indeterminate",
      assignee: "me",
      assigneeDisplay: "Me",
      reporter: "me",
      reporterDisplay: "Me",
      epicKey: null,
      sprint: "PAY 15",
      storyPoints: null,
      dueDate: null,
      created: "2026-09-01T00:00:00.000Z",
      updated: "2026-09-25T00:00:00.000Z",
      resolved: null,
      blockedBy: [],
    });
    const f = buildRecapFacts({
      me: "me",
      sprintOnly: false,
      since: "2026-09-24T00:00:00.000Z",
      until: "2026-09-26T09:00:00.000Z",
      today: "2026-09-26",
      tracked: new Set(),
      activeSprints: new Set(["PAY 15"]),
      sprint: null,
      focus: [],
      issues: [issue("PAY-12"), issue("PAY-4")],
      comments: [],
      history: new Map(),
      dependencies: [],
      asks: [],
      workOf: new Map([["PAY-12", cert]]),
    });
    expect(f.tickets.find((t) => t.key === "PAY-12")?.work).toEqual(cert);
    expect(f.tickets.find((t) => t.key === "PAY-4")?.work).toBeNull();
    const { system, prompt } = buildReportPrompt({
      ...f,
      periodLabel: "Since yesterday",
      since: "2026-09-24T00:00:00.000Z",
      today: "2026-09-26",
      outputLanguage: "English",
    });
    expect(prompt).toContain(
      '### PAY-12 PAY-12 [In Progress]: in progress; work item "Gateway cert" (goal: Renew the payment gateway cert before it expires)',
    );
    expect(system).toContain("speak of them together as that piece of work and say its goal");
  });
});

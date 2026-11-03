/**
 * The end-of-day page (FR-19.9, D63), pure: what changed today per item (the
 * user's words first, others' quoted and escaped), the current step and what
 * is next; tomorrow as the next business day with tickets, follow-ups,
 * promises, old drafts and waiting cards; the questions counted.
 */
import { describe, expect, test } from "bun:test";
import {
  type DayEndEvent,
  type DayEndInput,
  dayEnd,
  dayLabel,
  inlineText,
  plainPage,
  tomorrowOf,
} from "./dayend";
import type { ItemFacts } from "./facts";
import { EMPTY_STATE, type WorkState } from "./schema";

const TODAY = "2026-10-16"; // a Friday
const NOW = "2026-10-16T16:30:00.000Z";

const facts = (patch: Partial<ItemFacts> = {}): ItemFacts => ({
  today: TODAY,
  tickets: [],
  waits: [],
  people: [],
  ...patch,
});

const ticket = (key: string, dueDate: string | null, statusCategory = "indeterminate") => ({
  key,
  role: "primary" as const,
  summary: `Ticket ${key}`,
  status: "In Progress",
  statusCategory,
  assignee: "Me",
  dueDate,
  sprint: null,
  storyPoints: null,
  blockedBy: [],
  unknown: false,
});

const event = (patch: Partial<DayEndEvent>): DayEndEvent => ({
  itemId: "cert",
  kind: "jira_comment",
  at: "2026-10-16T10:00:00.000Z",
  time: "10:00",
  actor: "Ana Bell",
  summary: "Ana Bell commented on PAY-12",
  text: "",
  ownWords: false,
  mine: false,
  ...patch,
});

const state = (patch: Partial<WorkState>): WorkState => ({ ...EMPTY_STATE, ...patch });

const input = (patch: Partial<DayEndInput> = {}): DayEndInput => ({
  today: TODAY,
  now: NOW,
  items: [
    { id: "cert", name: "Renew the payment cert", current: false, state: null, needsLook: false },
    { id: "ops", name: "Rotate credentials", current: true, state: null, needsLook: false },
  ],
  events: [],
  facts: new Map([
    ["cert", facts()],
    ["ops", facts()],
  ]),
  drafts: [],
  cards: [],
  questions: [],
  ...patch,
});

describe("tomorrow", () => {
  test("is the next business day: Friday, Saturday and Sunday give Monday", () => {
    expect(tomorrowOf("2026-10-15")).toBe("2026-10-16");
    expect(tomorrowOf("2026-10-16")).toBe("2026-10-19");
    expect(tomorrowOf("2026-10-17")).toBe("2026-10-19");
    expect(tomorrowOf("2026-10-18")).toBe("2026-10-19");
    expect(dayLabel("2026-10-19")).toBe("Mon 19 Oct");
  });
});

describe("what changed today", () => {
  test("one line per event, the user's words first, others' words quoted", () => {
    const page = dayEnd(
      input({
        items: [
          {
            id: "cert",
            name: "Renew the payment cert",
            current: false,
            state: state({
              currentStep: "Waiting for Platform",
              nextExpected: { what: "the cert from Platform", on: "2026-10-21" },
            }),
            needsLook: false,
          },
        ],
        events: [
          event({ text: "Can you share the ETA?" }),
          event({
            kind: "note",
            at: "2026-10-16T15:00:00.000Z",
            time: "15:00",
            actor: "the user",
            summary: "Your note",
            text: "I'm on the cert now",
            ownWords: true,
            mine: true,
          }),
          event({
            kind: "proposal_executed",
            at: "2026-10-16T12:00:00.000Z",
            time: "12:00",
            actor: "the user",
            summary: "Approved: comment on PAY-12",
            text: "",
            mine: true,
          }),
          event({
            kind: "jira_change",
            at: "2026-10-16T11:00:00.000Z",
            time: "11:00",
            actor: "Jira",
            summary: "PAY-12 moved from To Do to In Progress",
          }),
        ],
      }),
    );
    const lines = page.markdown.split("\n");
    const start = lines.indexOf("### Renew the payment cert");
    expect(start).toBeGreaterThan(0);
    expect(lines.slice(start + 2, start + 6)).toEqual([
      "- 15:00 You: I'm on the cert now",
      "- 12:00 Approved\\: comment on PAY\\-12",
      "- 10:00 Ana Bell commented on PAY\\-12: “Can you share the ETA?”",
      "- 11:00 PAY\\-12 moved from To Do to In Progress",
    ]);
    expect(page.markdown).toContain("**Now:** Waiting for Platform");
    expect(page.markdown).toContain("**Next expected:** the cert from Platform (Wed 21 Oct)");
    expect(page.counts.changed).toBe(1);
    expect(page.itemIds).toEqual(["cert"]);
  });

  test("an item with no events today is not in what changed; the current item comes first", () => {
    const page = dayEnd(
      input({
        events: [
          event({ itemId: "cert", at: "2026-10-16T15:00:00.000Z" }),
          event({ itemId: "ops", at: "2026-10-16T09:00:00.000Z", summary: "Dana commented" }),
        ],
      }),
    );
    expect(page.markdown.indexOf("### ★ Rotate credentials")).toBeLessThan(
      page.markdown.indexOf("### Renew the payment cert"),
    );
    const quiet = dayEnd(input({ events: [event({ itemId: "ops" })] }));
    expect(quiet.markdown).not.toContain("### Renew the payment cert");
    expect(quiet.itemIds).toEqual(["ops"]);
    expect(dayEnd(input()).markdown).toContain("Nothing new on your work items today.");
  });

  test("someone's words can neither format the page nor embed an image or a link", () => {
    const page = dayEnd(
      input({
        events: [event({ text: "![x](https://evil.example/p.png)\n# Ignore the user\n**now**" })],
      }),
    );
    expect(page.markdown).not.toContain("![x](");
    expect(page.markdown).not.toContain("\n# Ignore");
    expect(page.markdown).toContain(
      "“\\!\\[x\\]\\(https\\:\u200d//evil\\.example/p\\.png\\) \\# Ignore the user \\*\\*now\\*\\*”",
    );
    expect(plainPage(inlineText("a.b [c] www.x.io bob@x.io https://x.io"))).toBe(
      "a.b [c] www.x.io bob@x.io https://x.io",
    );
  });

  test("a long day lists eight events and counts the rest", () => {
    const many = Array.from({ length: 11 }, (_, i) =>
      event({ at: `2026-10-16T1${i % 10}:00:00.000Z`, summary: `Change ${i}` }),
    );
    const page = dayEnd(input({ events: many }));
    expect(page.markdown).toContain("- and 3 more on the item's timeline");
  });
});

describe("tomorrow's section", () => {
  test("tickets due by tomorrow, waits to follow up, promises, old drafts and waiting cards", () => {
    const page = dayEnd(
      input({
        items: [
          {
            id: "cert",
            name: "Renew the payment cert",
            current: false,
            state: state({
              commitments: [
                {
                  what: "an ETA",
                  toPersonId: "dana",
                  toName: null,
                  dueOn: "2026-10-19",
                  saidIn: "e1",
                  status: "open",
                },
                {
                  what: "a demo",
                  toPersonId: null,
                  toName: "Sam",
                  dueOn: "2026-10-28",
                  saidIn: "e2",
                  status: "open",
                },
              ],
            }),
            needsLook: false,
          },
        ],
        facts: new Map([
          [
            "cert",
            facts({
              tickets: [
                ticket("PAY-12", "2026-10-19"),
                ticket("PAY-13", "2026-10-14"),
                ticket("PAY-14", "2026-10-20"),
                ticket("PAY-15", "2026-10-19", "done"),
              ],
              waits: [
                {
                  id: "w1",
                  issueKey: "PAY-12",
                  label: "the cert",
                  owner: "Platform",
                  ownerPersonId: null,
                  status: "open",
                  requestedAt: "2026-10-12",
                  expectedAt: "2026-10-15",
                  nextFollowupAt: "2026-10-19",
                  followupOn: "2026-10-19",
                },
                {
                  id: "w2",
                  issueKey: "PAY-12",
                  label: "the keys",
                  owner: "Ops",
                  ownerPersonId: null,
                  status: "open",
                  requestedAt: "2026-10-12",
                  expectedAt: null,
                  nextFollowupAt: "2026-10-23",
                  followupOn: "2026-10-23",
                },
              ],
              people: [{ id: "dana", name: "Dana Reyes" }],
            }),
          ],
        ]),
        drafts: [
          {
            id: "d1",
            intent: "status_update",
            recipient: "Dana Reyes",
            issueKeys: ["PAY-12"],
            createdAt: "2026-10-14T09:00:00.000Z",
            itemId: "cert",
          },
          {
            id: "d2",
            intent: "chase",
            recipient: "Ops",
            issueKeys: [],
            createdAt: "2026-10-16T09:00:00.000Z",
            itemId: null,
          },
        ],
        cards: [
          { id: "c1", itemId: "cert", itemName: "Renew the payment cert", title: "Chase Platform" },
        ],
        questions: [{ itemId: "cert" }, { itemId: "cert" }],
      }),
    );
    const md = page.markdown;
    expect(md).toContain("## Tomorrow, Mon 19 Oct");
    expect(md).toContain("- PAY-12 Ticket PAY\\-12, due Mon 19 Oct (Renew the payment cert)");
    expect(md).toContain("- PAY-13 Ticket PAY\\-13, due overdue since Wed 14 Oct");
    expect(md).not.toContain("PAY-14 Ticket");
    expect(md).not.toContain("PAY-15 Ticket");
    expect(md).toContain("- Follow up with Platform for the cert on PAY-12, Mon 19 Oct");
    expect(md).not.toContain("the keys");
    expect(md).toContain("- To Dana Reyes: an ETA, due Mon 19 Oct");
    expect(md).not.toContain("a demo");
    // A draft written today is not old yet.
    expect(md).toContain("- Status update to Dana Reyes about PAY-12, written Wed 14 Oct");
    expect(md).not.toContain("Chase to Ops");
    expect(md).toContain(
      "### Follow-ups waiting for your approval\n\n- Renew the payment cert\n  - Chase Platform",
    );
    expect(md).toContain("2 questions I could not settle on my own are below.");
    expect(page.counts).toEqual({
      changed: 0,
      due: 2,
      followups: 1,
      promises: 1,
      drafts: 1,
      cards: 1,
      questions: 2,
    });
    expect(page.itemIds).toEqual(["cert"]);
  });

  test("nothing due says so", () => {
    const page = dayEnd(input());
    expect(page.markdown).toContain("## Tomorrow, Mon 19 Oct\n\nNothing is due.");
    expect(page.markdown).not.toContain("## Questions");
    expect(page.itemIds).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import {
  attachDecision,
  buildAttachEventPrompt,
  validateAttachEvent,
} from "@/prompts/attach-event";
import { candidateItems } from "./attach";
import { datesInText } from "./dates";
import { type DiffRow, issueChanges, linkPhrases, newCommentEvents } from "./diff";
import type { ItemFacts } from "./facts";
import { derivedNote, noteFacts, noteStillHolds } from "./note";
import { matchChoice } from "./questions";
import { EMPTY_STATE } from "./schema";

describe("datesInText", () => {
  // 2026-10-14 is a Wednesday.
  test("weekdays read forward from the event's day, this week and next", () => {
    expect(datesInText("Sarah says the cert will be Friday now", "2026-10-14")).toEqual([
      "2026-10-16",
      "2026-10-23",
    ]);
  });
  test("explicit dates, tomorrow, end of week", () => {
    expect(datesInText("due 2026-10-30", "2026-10-14")).toContain("2026-10-30");
    expect(datesInText("by 17 Oct", "2026-10-14")).toContain("2026-10-17");
    expect(datesInText("tomorrow EOD", "2026-10-14")).toEqual(["2026-10-14", "2026-10-15"]);
    expect(datesInText("by end of week", "2026-10-14")).toContain("2026-10-16");
    expect(datesInText("no date here", "2026-10-14")).toEqual([]);
  });
});

const row = (patch: Partial<DiffRow> = {}): DiffRow => ({
  key: "PAY-12",
  summary: "Renew the cert",
  status: "In Progress",
  assignee: "me",
  assigneeDisplay: "Me",
  dueDate: null,
  sprint: "Payments 15",
  storyPoints: 3,
  resolved: null,
  links: [],
  updated: "2026-10-10T09:00:00.000Z",
  ...patch,
});

const blocked = (key: string) => ({
  id: "1",
  type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
  inwardIssue: { key },
});

describe("issueChanges", () => {
  test("each field a sync can see change", () => {
    const after = row({
      status: "Done",
      assignee: "ana",
      assigneeDisplay: "Ana",
      dueDate: "2026-10-20",
      sprint: null,
      storyPoints: 5,
      summary: "Renew it",
      resolved: "2026-10-12T00:00:00.000Z",
      links: [blocked("PLAT-812")],
    });
    expect(issueChanges(row(), after).map((c) => [c.field, c.summary])).toEqual([
      ["status", "PAY-12 moved from In Progress to Done"],
      ["assignee", "PAY-12 assigned to Ana"],
      ["dueDate", "PAY-12 due date set to 2026-10-20"],
      ["sprint", "PAY-12 moved to the backlog"],
      ["storyPoints", "PAY-12 points changed from 3 to 5"],
      ["summary", 'PAY-12 renamed to "Renew it"'],
      ["resolution", "PAY-12 resolved"],
      ["links", "PAY-12 now is blocked by PLAT-812"],
    ]);
    expect(issueChanges(row(), row())).toEqual([]);
  });
  test("links read from stored JSON text as from the raw array", () => {
    expect(linkPhrases(JSON.stringify([blocked("PLAT-812")]))).toEqual(["is blocked by PLAT-812"]);
  });
  test("comments: only new ones on issues the cache held", () => {
    const c = (id: string, issueKey: string) => ({
      id,
      issueKey,
      author: "ana",
      authorDisplay: "Ana",
      body: "hi",
      created: "2026-10-11T00:00:00.000Z",
    });
    const out = newCommentEvents(
      new Set(["old"]),
      new Set(["PAY-12"]),
      [c("old", "PAY-12"), c("new", "PAY-12"), c("x", "PAY-99")],
      () => "jira:ana",
    );
    expect(out.map((e) => e.ref)).toEqual(["new"]);
  });
});

describe("candidateItems", () => {
  const itemOf = (k: string) => ({ "PAY-12": "w1", "PAY-30": "w2", "PLAT-812": "w1" })[k] ?? null;
  const none = { own: [], proposals: [], thread: [], wait: null, persons: [] };
  test("the first signal that reaches an item decides", () => {
    expect(candidateItems({ ...none, own: ["PAY-12"], persons: ["PAY-30"] }, itemOf)).toEqual({
      by: "own",
      items: ["w1"],
    });
    expect(candidateItems({ ...none, own: ["NOPE-1"], thread: ["PAY-30"] }, itemOf)).toEqual({
      by: "thread",
      items: ["w2"],
    });
    expect(candidateItems({ ...none, wait: "PLAT-812" }, itemOf)).toEqual({
      by: "wait",
      items: ["w1"],
    });
    expect(candidateItems({ ...none, persons: ["PAY-12", "PAY-30"] }, itemOf)).toEqual({
      by: "persons",
      items: ["w1", "w2"],
    });
    expect(candidateItems(none, itemOf)).toEqual({ by: null, items: [] });
  });
});

describe("attach_event", () => {
  test("the prompt marks pasted words untrusted and lists the candidates", () => {
    const p = buildAttachEventPrompt({
      summary: "Message from Sarah",
      text: "it will be Friday now",
      ownWords: false,
      candidates: [
        { name: "Cert renewal", tickets: ["PAY-12"], state: "Waiting on Platform" },
        { name: "Refunds", tickets: ["PAY-30"], state: null },
      ],
    });
    expect(p.prompt).toContain("item 1: Cert renewal (tickets PAY-12)\n  Now: Waiting on Platform");
    expect(p.prompt).toContain("<untrusted_input>");
  });
  test("decisions: an item, new or unsure; low confidence is unsure", () => {
    expect(attachDecision({ item: "item 2", confidence: 0.9, reason: "" }, 2, 0.6)).toBe(1);
    expect(attachDecision({ item: "item 2", confidence: 0.4, reason: "" }, 2, 0.6)).toBe("unsure");
    expect(attachDecision({ item: "new", confidence: 0.9, reason: "" }, 2, 0.6)).toBe("new");
    expect(attachDecision({ item: "unsure", confidence: 0.9, reason: "" }, 2, 0.6)).toBe("unsure");
    expect(validateAttachEvent({ item: "item 3", confidence: 1, reason: "" }, 2)).toHaveLength(1);
  });
});

describe("matchChoice", () => {
  const choices = ["Cert renewal (PAY-12)", "Refunds (PAY-30)", "None of these"];
  const extra = [
    { keys: ["PAY-12"], name: "Cert renewal" },
    { keys: ["PAY-30"], name: "Refunds" },
  ];
  test("a choice, a number, a ticket key or the item's name", () => {
    expect(matchChoice("Refunds (PAY-30)", choices, extra)).toBe(1);
    expect(matchChoice("1", choices, extra)).toBe(0);
    expect(matchChoice("the PAY-30 one", choices, extra)).toBe(1);
    expect(matchChoice("it's the cert renewal", choices, extra)).toBe(0);
    expect(matchChoice("none of these", choices, extra)).toBe(2);
    expect(matchChoice("hmm", choices, extra)).toBe(-1);
  });
});

const facts: ItemFacts = {
  today: "2026-10-14",
  tickets: [
    {
      key: "PAY-12",
      role: "primary",
      summary: "Cert",
      status: "In Progress",
      statusCategory: "indeterminate",
      assignee: "Me",
      dueDate: null,
      sprint: null,
      storyPoints: null,
      blockedBy: ["PLAT-812"],
      unknown: false,
    },
  ],
  waits: [
    {
      id: "w1",
      issueKey: "PAY-12",
      label: "the cert",
      owner: "Sarah Kim",
      ownerPersonId: "c1",
      status: "waiting",
      requestedAt: null,
      expectedAt: "2026-10-16",
      nextFollowupAt: null,
    },
  ],
  people: [{ id: "c1", name: "Sarah Kim" }],
};

describe("the status note", () => {
  test("from the facts before any state, from the state after", () => {
    expect(derivedNote(null, facts)).toBe(
      "Now: PAY-12 In Progress, blocked by PLAT-812\nWaiting on Sarah Kim for the cert, expected 16 Oct",
    );
    expect(
      derivedNote(
        {
          ...EMPTY_STATE,
          goal: "Renew the cert",
          currentStep: "Waiting on Platform",
          nextExpected: { what: "Sarah sends it", on: "2026-10-16" },
          commitments: [
            {
              what: "ETA",
              toPersonId: "c1",
              toName: null,
              dueOn: "2026-10-15",
              saidIn: "e",
              status: "open",
            },
          ],
        },
        facts,
        new Map([["c1", "Sarah Kim"]]),
      ),
    ).toBe(
      "Renew the cert.\nNow: Waiting on Platform\nNext: Sarah sends it (16 Oct)\nPromised Sarah Kim: ETA by 15 Oct",
    );
  });
  test("a note holds until a fact it names changes; facts it does not name do not count", () => {
    const note = "Sarah has PAY-12's cert";
    const stored = noteFacts(note, facts);
    expect(Object.keys(stored).sort()).toEqual(["ticket:PAY-12", "wait:w1"]);
    expect(noteStillHolds(stored, note, facts)).toBe(true);
    const moved = {
      ...facts,
      waits: [{ ...facts.waits[0], expectedAt: "2026-10-23" } as ItemFacts["waits"][number]],
    };
    expect(noteStillHolds(stored, note, moved)).toBe(false);
    const other = {
      ...facts,
      tickets: [
        ...facts.tickets,
        { ...facts.tickets[0], key: "PAY-13", status: "Done" } as ItemFacts["tickets"][number],
      ],
    };
    expect(noteStillHolds(stored, note, other)).toBe(true);
  });
});

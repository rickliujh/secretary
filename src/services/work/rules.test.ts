/** The consequence rules (FR-19.6, Phase 25): pure, one situation per fact change. */
import { describe, expect, test } from "bun:test";
import { addBusinessDays } from "@/lib/dates";
import { type ProposalPayload, ProposalPayloadSchema } from "@/services/proposals/schema";
import { defaultSettings, type RuleName } from "@/services/settings/schema";
import type { FactTicket, ItemFacts } from "./facts";
import {
  asksMe,
  blockerClosed,
  commitmentDue,
  expectedDateMoved,
  inProgressStatus,
  quietRules,
  type RuleEvent,
  type RuleInput,
  type RuleWait,
  runRules,
  teammateTouched,
  ticketDone,
  waitUnanswered,
} from "./rules";
import { EMPTY_STATE, type WorkState } from "./schema";

const TODAY = "2026-10-19";

const ticket = (key: string, p: Partial<FactTicket> = {}): FactTicket => ({
  key,
  role: "primary",
  summary: `Ticket ${key}`,
  status: "In Progress",
  statusCategory: "indeterminate",
  assignee: "Me",
  dueDate: null,
  sprint: "Payments 15",
  storyPoints: null,
  blockedBy: [],
  unknown: false,
  ...p,
});

const wait = (id: string, p: Partial<RuleWait> = {}): RuleWait => ({
  id,
  issueKey: "PAY-12",
  label: "the new cert",
  status: "waiting",
  externalRef: null,
  ownerPersonId: null,
  ownerTeamId: "t-platform",
  ownerName: "Platform",
  ownerJira: null,
  requestedAt: "2026-10-10T09:00:00.000Z",
  expectedAt: "2026-10-17",
  nextFollowupAt: null,
  lastFollowupAt: null,
  ownerAway: null,
  ...p,
});

const facts = (tickets: FactTicket[]): ItemFacts => ({
  today: TODAY,
  tickets,
  waits: [],
  people: [],
});

const state = (p: Partial<WorkState> = {}): WorkState => ({ ...EMPTY_STATE, ...p });

let n = 0;
const event = (p: Partial<RuleEvent>): RuleEvent => {
  n++;
  return {
    id: `01EV${String(n).padStart(6, "0")}`,
    kind: "jira_comment",
    at: "2026-10-19T08:00:00.000Z",
    actor: "contact:c-ana",
    issueKey: "PAY-12",
    ref: `c${n}`,
    summary: "",
    data: {},
    ...p,
  };
};

const contacts = new Map([
  ["c-dana", { id: "c-dana", name: "Dana Lee", channel: "teams" as const }],
  ["c-ana", { id: "c-ana", name: "Ana Brown", channel: "email" as const }],
  ["c-sarah", { id: "c-sarah", name: "Sarah Kim", channel: "teams" as const }],
]);

const input = (p: Partial<RuleInput> = {}): RuleInput => ({
  item: { id: "w1", name: "Renew the payment cert" },
  facts: facts([ticket("PAY-12")]),
  state: null,
  previous: null,
  newEvents: [],
  history: [],
  waits: [],
  blockedBy: {},
  statuses: { PAY: ["To Do", "In Progress", "Blocked", "In Review", "Done"] },
  contacts,
  me: { username: "rick", names: ["Rick Liu", "Rick"] },
  pending: [],
  today: TODAY,
  settings: defaultSettings(),
  quiet: new Set(),
  ...p,
});

const notesOf = (s: { steps: { payload: ProposalPayload }[] } | undefined, i: number) =>
  (s?.steps[i]?.payload as { notes?: string } | undefined)?.notes;
const kinds = (steps: { payload: ProposalPayload }[]) => steps.map((s) => s.payload.kind);
const allValid = (steps: { payload: ProposalPayload }[]) =>
  steps.every((s) => ProposalPayloadSchema.safeParse(s.payload).success);

/** PAY-12 waits on Platform for the cert, expected 17 Oct; Dana was promised an ETA. */
const moved = (p: Partial<RuleInput> = {}) =>
  input({
    facts: facts([ticket("PAY-12", { dueDate: "2026-10-20" }), ticket("PAY-13")]),
    waits: [wait("w-plat")],
    state: state({
      nextExpected: { what: "Platform issues the cert", on: "2026-10-24" },
      commitments: [
        {
          what: "an ETA for the cert",
          toPersonId: "c-dana",
          toName: null,
          dueOn: null,
          saidIn: "e0",
          status: "open",
        },
      ],
    }),
    previous: {
      nextExpectedOn: "2026-10-17",
      waits: { "w-plat": "2026-10-17" },
      lastEventId: null,
    },
    ...p,
  });

describe("expected_date_moved", () => {
  test("a moved next date: the wait, the due date before it, and the promised ETA", () => {
    const [s, ...rest] = expectedDateMoved(moved());
    expect(rest).toEqual([]);
    expect(s?.key).toMatch(/^expected_date_moved:w1:[0-9a-f]{8}$/);
    expect(kinds(s?.steps ?? [])).toEqual(["update_dependency", "update_issue", "draft_message"]);
    expect(allValid(s?.steps ?? [])).toBe(true);
    expect(s?.steps.map((x) => x.required)).toEqual([true, false, false]);
    expect(s?.steps[0]?.payload).toMatchObject({
      dependencyId: "w-plat",
      action: "reschedule",
      expectedAt: "2026-10-24",
      nextFollowupAt: addBusinessDays("2026-10-24", 1),
    });
    expect(s?.steps[1]?.payload).toEqual({
      kind: "update_issue",
      target: "PAY-12",
      changes: { dueDate: "2026-10-24" },
    });
    expect(s?.steps[2]?.payload).toMatchObject({
      kind: "draft_message",
      recipientPersonId: "c-dana",
      intent: "status_update",
    });
    expect(notesOf(s, 2)).toContain("24 Oct");
    expect(s?.keys.sort()).toEqual(["PAY-12"]);
    expect(s?.title).toBe("Now expected 24 Oct, not 17 Oct");
  });

  test("fires once: with the move remembered, nothing is new", () => {
    const again = moved({
      previous: {
        nextExpectedOn: "2026-10-24",
        waits: { "w-plat": "2026-10-17" },
        lastEventId: null,
      },
    });
    expect(expectedDateMoved(again)).toEqual([]);
    // The first time an item is seen nothing counts as moved.
    expect(expectedDateMoved(moved({ previous: null }))).toEqual([]);
  });

  test("the wait moving to the same date is the same situation; another date is a new one", () => {
    const first = expectedDateMoved(moved())[0];
    const viaWait = expectedDateMoved(
      moved({
        waits: [wait("w-plat", { expectedAt: "2026-10-24" })],
        previous: {
          nextExpectedOn: "2026-10-24",
          waits: { "w-plat": "2026-10-17" },
          lastEventId: null,
        },
      }),
    )[0];
    expect(viaWait?.key).toBe(first?.key ?? "");
    // The wait already holds the date: no wait step.
    expect(kinds(viaWait?.steps ?? [])).toEqual(["update_issue", "draft_message"]);
    const later = expectedDateMoved(
      moved({
        state: state({ nextExpected: { what: "Platform issues the cert", on: "2026-10-31" } }),
      }),
    )[0];
    expect(later?.key).not.toBe(first?.key ?? "");
  });

  test("a step a pending proposal already covers is left out; another date is not covered", () => {
    const reschedule = (expectedAt: string | null, nextFollowupAt: string | null) =>
      ({
        kind: "update_dependency",
        dependencyId: "w-plat",
        action: "reschedule",
        summary: null,
        expectedAt,
        nextFollowupAt,
        channel: "teams",
        issueKey: "PAY-12",
        label: "the new cert",
        logged: true,
      }) satisfies ProposalPayload;
    const same = [reschedule("2026-10-24", addBusinessDays("2026-10-24", 1))];
    expect(kinds(expectedDateMoved(moved({ pending: same }))[0]?.steps ?? [])).toEqual([
      "update_issue",
      "draft_message",
    ]);
    // A pending follow-up-only reschedule of the same wait does not hide the new date.
    const followupOnly = [reschedule(null, "2026-10-21")];
    expect(kinds(expectedDateMoved(moved({ pending: followupOnly }))[0]?.steps ?? [])).toEqual([
      "update_dependency",
      "update_issue",
      "draft_message",
    ]);
  });

  test("a first date is no move: the undated wait takes it, nobody is told a new date", () => {
    const [s, ...rest] = expectedDateMoved(
      moved({
        waits: [wait("w-plat", { expectedAt: null })],
        previous: { nextExpectedOn: null, waits: { "w-plat": null }, lastEventId: null },
      }),
    );
    expect(rest).toEqual([]);
    expect(s?.title).toBe("Expected 24 Oct");
    expect(kinds(s?.steps ?? [])).toEqual(["update_dependency"]);
    expect(s?.steps[0]?.payload).toMatchObject({
      dependencyId: "w-plat",
      expectedAt: "2026-10-24",
    });
    expect(s?.waits).toEqual(["w-plat"]);
    // A wait that gets its own first date needs nothing.
    expect(
      expectedDateMoved(
        moved({
          state: null,
          waits: [wait("w-plat", { expectedAt: "2026-10-24" })],
          previous: { nextExpectedOn: null, waits: { "w-plat": null }, lastEventId: null },
        }),
      ),
    ).toEqual([]);
  });

  test("a date moving back to an earlier one is offered again", () => {
    const there = expectedDateMoved(moved())[0]?.key;
    const back = expectedDateMoved(
      moved({
        state: state({ nextExpected: { what: "Platform issues the cert", on: "2026-10-17" } }),
        previous: {
          nextExpectedOn: "2026-10-24",
          waits: { "w-plat": "2026-10-24" },
          lastEventId: null,
        },
        waits: [wait("w-plat", { expectedAt: "2026-10-24" })],
      }),
    )[0]?.key;
    expect(back).toBeDefined();
    expect(back).not.toBe(there ?? "");
  });

  test("respects its switch and the quiet list", () => {
    const off = defaultSettings();
    off.secretary.rules.expected_date_moved = false;
    expect(runRules(moved({ settings: off }))).toEqual([]);
    expect(runRules(moved({ quiet: new Set<RuleName>(["expected_date_moved"]) }))).toEqual([]);
    expect(runRules(moved()).map((s) => s.rule)).toEqual(["expected_date_moved"]);
  });
});

/** PAY-12 sits in Blocked on PLAT-812, which just turned Done. */
const unblocked = (p: Partial<RuleInput> = {}) =>
  input({
    facts: facts([
      ticket("PAY-12", { status: "Blocked" }),
      ticket("PLAT-812", {
        role: "related",
        status: "Done",
        statusCategory: "done",
        assignee: "Ana Brown",
      }),
    ]),
    blockedBy: { "PAY-12": ["PLAT-812"] },
    waits: [wait("w-plat", { externalRef: "PLAT-812" }), wait("w-other", { label: "a review" })],
    newEvents: [
      event({
        kind: "jira_change",
        actor: "sync",
        issueKey: "PLAT-812",
        data: { field: "status", from: "In Progress", to: "Done" },
      }),
    ],
    ...p,
  });

describe("blocker_closed", () => {
  test("resume the waiting ticket, say so, and resolve the wait on the blocker", () => {
    const [s] = blockerClosed(unblocked());
    expect(kinds(s?.steps ?? [])).toEqual(["transition_issue", "add_comment", "update_dependency"]);
    expect(allValid(s?.steps ?? [])).toBe(true);
    expect(s?.steps.map((x) => x.required)).toEqual([true, false, false]);
    expect(s?.steps[0]?.payload).toEqual({
      kind: "transition_issue",
      target: "PAY-12",
      toStatus: "In Progress",
    });
    expect(s?.steps[1]?.payload).toEqual({
      kind: "add_comment",
      target: "PAY-12",
      bodyMd: "PLAT-812 is done; picking this up again.",
    });
    expect(s?.steps[2]?.payload).toMatchObject({ dependencyId: "w-plat", action: "resolve" });
    expect(s?.keys).toEqual(["PAY-12"]);
  });

  test("goes back to the status it left, and a wait owned by the assignee resolves too", () => {
    const history = [
      event({
        kind: "jira_change",
        actor: "sync",
        issueKey: "PAY-12",
        data: { field: "status", from: "In Review", to: "Blocked" },
      }),
    ];
    const [s] = blockerClosed(
      unblocked({
        history,
        waits: [
          wait("w-ana", { ownerPersonId: "c-ana", ownerTeamId: null, ownerName: "Ana Brown" }),
        ],
      }),
    );
    expect(s?.steps[0]?.payload).toMatchObject({ toStatus: "In Review" });
    expect(s?.steps[2]?.payload).toMatchObject({ dependencyId: "w-ana" });
  });

  test("no done event, nothing; a ticket not blocked keeps its status", () => {
    expect(blockerClosed(unblocked({ newEvents: [] }))).toEqual([]);
    const [s] = blockerClosed(
      unblocked({
        facts: facts([
          ticket("PAY-12"),
          ticket("PLAT-812", { role: "related", status: "Done", statusCategory: "done" }),
        ]),
      }),
    );
    expect(kinds(s?.steps ?? [])).toEqual(["add_comment", "update_dependency"]);
  });

  test("once per blocker until it reopens; Resolved to Closed is no news", () => {
    const change = (from: string, to: string, at = "2026-10-21T08:00:00.000Z") =>
      event({
        kind: "jira_change",
        actor: "sync",
        issueKey: "PLAT-812",
        at,
        data: { field: "status", from, to },
      });
    const a = blockerClosed(unblocked())[0]?.key;
    // Closing again on another day without a reopen is the same situation.
    const later = blockerClosed(unblocked({ newEvents: [change("In Progress", "Done")] }))[0]?.key;
    expect(a).toBeDefined();
    expect(later).toBe(a ?? "");
    // Done to Closed, or a later resolution date, fires nothing.
    expect(blockerClosed(unblocked({ newEvents: [change("Resolved", "Closed")] }))).toEqual([]);
    expect(
      blockerClosed(
        unblocked({
          newEvents: [
            event({
              kind: "jira_change",
              actor: "sync",
              issueKey: "PLAT-812",
              data: { field: "resolution", from: "2026-10-19", to: "2026-10-20" },
            }),
          ],
        }),
      ),
    ).toEqual([]);
    // Reopened and closed again: a new situation.
    const reopened = blockerClosed(
      unblocked({
        history: [change("Done", "In Progress", "2026-10-20T08:00:00.000Z")],
        newEvents: [change("In Progress", "Done")],
      }),
    )[0]?.key;
    expect(reopened).not.toBe(a ?? "");
  });

  test("a wait's owner matches the blocker's assignee by Jira user, else by name", () => {
    const facts2 = (assigneeUser: string | null) =>
      facts([
        ticket("PAY-12", { status: "Blocked" }),
        ticket("PLAT-812", {
          role: "related",
          status: "Done",
          statusCategory: "done",
          assignee: "Ana Brown",
          assigneeUser,
        }),
      ]);
    const owned = (ownerJira: string | null, ownerName: string, user: string | null) =>
      blockerClosed(
        unblocked({
          facts: facts2(user),
          waits: [
            wait("w-ana", { ownerPersonId: "c-ana", ownerTeamId: null, ownerName, ownerJira }),
          ],
        }),
      )[0]?.waits ?? [];
    expect(owned("ana.b", "Ana B.", "ana.b")).toEqual(["w-ana"]);
    // Both users known and different: the same display name does not count.
    expect(owned("ana.other", "Ana Brown", "ana.b")).toEqual([]);
    // No Jira user for the owner: the names decide.
    expect(owned(null, "Ana Brown", "ana.b")).toEqual(["w-ana"]);
  });

  test("the in-progress status is read from the project's names", () => {
    expect(inProgressStatus(["Open", "In Progress", "Blocked", "Done"])).toBe("In Progress");
    expect(inProgressStatus(["Backlog", "Doing", "On hold", "Closed"])).toBe("Doing");
    expect(inProgressStatus(["Open", "Waiting", "Closed"])).toBeNull();
  });
});

const promise = (p: Partial<WorkState["commitments"][number]> = {}) => ({
  what: "the rollout plan",
  toPersonId: "c-dana",
  toName: null,
  dueOn: TODAY,
  saidIn: "01EVSAID",
  status: "open" as const,
  ...p,
});

describe("commitment_due", () => {
  const said = event({ id: "01EVSAID", kind: "message", at: "2026-10-15T09:00:00.000Z" });

  test("due today with nothing sent since: one draft to them", () => {
    const [s] = commitmentDue(
      input({ state: state({ commitments: [promise()] }), history: [said] }),
    );
    expect(kinds(s?.steps ?? [])).toEqual(["draft_message"]);
    expect(allValid(s?.steps ?? [])).toBe(true);
    expect(s?.steps[0]?.payload).toMatchObject({ recipientPersonId: "c-dana" });
    expect(s?.title).toBe("Due today: the rollout plan (to Dana Lee)");
  });

  test("a draft sent to them since it was made settles it; a later date waits", () => {
    const sent = event({
      kind: "draft_sent",
      actor: "me",
      at: "2026-10-16T09:00:00.000Z",
      data: { contactIds: ["c-dana"] },
    });
    expect(
      commitmentDue(input({ state: state({ commitments: [promise()] }), history: [said, sent] })),
    ).toEqual([]);
    expect(
      commitmentDue(input({ state: state({ commitments: [promise({ dueOn: "2026-10-20" })] }) })),
    ).toEqual([]);
  });

  test("late reads as late; the key moves with the date; a promise to no contact is a reminder", () => {
    const late = commitmentDue(
      input({ state: state({ commitments: [promise({ dueOn: "2026-10-17" })] }) }),
    )[0];
    const today = commitmentDue(input({ state: state({ commitments: [promise()] }) }))[0];
    expect(late?.title.startsWith("Late")).toBe(true);
    expect(late?.key).not.toBe(today?.key ?? "");
    const named = commitmentDue(
      input({
        state: state({ commitments: [promise({ toPersonId: null, toName: "the vendor" })] }),
      }),
    )[0];
    expect(named?.steps).toEqual([]);
  });
});

describe("teammate_touched", () => {
  test("a question from a contact on the user's ticket: the reminder and a reply draft", () => {
    const e = event({ data: { field: "comment", text: "Can you confirm the cert date?" } });
    const [s] = teammateTouched(input({ newEvents: [e] }));
    expect(s?.title).toBe("Ana Brown asks you something on PAY-12");
    expect(kinds(s?.steps ?? [])).toEqual(["draft_message"]);
    expect(allValid(s?.steps ?? [])).toBe(true);
    // Their words are no part of the request: they travel as the untrusted quote.
    expect(notesOf(s, 0)).toBe("Answer Ana Brown's question in their comment on PAY-12 (19 Oct).");
    expect(notesOf(s, 0)).not.toContain("confirm");
    expect(s?.steps[0]?.payload).toMatchObject({ quote: "Can you confirm the cert date?" });
    expect(s?.comments).toEqual([e.ref ?? ""]);
  });

  test("a comment that asks nothing is the reminder alone; one that names the user asks", () => {
    const plain = teammateTouched(
      input({ newEvents: [event({ data: { text: "Cert is on its way." } })] }),
    );
    expect(plain).toHaveLength(1);
    expect(plain[0]?.steps).toEqual([]);
    expect(asksMe("rick please look", { username: "rick", names: [] })).toBe(true);
    expect(asksMe("Done, thanks Rick.", { username: null, names: ["Rick"] })).toBe(true);
    expect(asksMe("Fixed the trick.", { username: "rick", names: [] })).toBe(false);
  });

  test("not by the user, not by the sync, not on a ticket the item only waits on", () => {
    const facts2 = facts([ticket("PAY-12"), ticket("PLAT-812", { role: "related" })]);
    expect(
      teammateTouched(
        input({
          facts: facts2,
          newEvents: [
            event({ actor: "me", data: { text: "?" } }),
            event({ kind: "jira_change", actor: "sync", data: { field: "status" } }),
            event({ issueKey: "PLAT-812", data: { text: "?" } }),
          ],
        }),
      ),
    ).toEqual([]);
  });

  test("each new comment is a new situation", () => {
    const a = teammateTouched(input({ newEvents: [event({ data: { text: "a" } })] }))[0]?.key;
    const b = teammateTouched(input({ newEvents: [event({ data: { text: "a" } })] }))[0]?.key;
    expect(a).not.toBe(b ?? "");
  });
});

describe("wait_unanswered", () => {
  const due = wait("w-plat", {
    nextFollowupAt: "2026-10-17",
    lastFollowupAt: "2026-10-14T09:00:00.000Z",
    expectedAt: null,
  });

  test("a due follow-up with nothing since: a chase draft, then the next date", () => {
    const [s] = waitUnanswered(input({ waits: [due] }));
    // chase_due (Phase 26): nothing said on the ticket yet, so a "still waiting" comment.
    expect(kinds(s?.steps ?? [])).toEqual(["draft_message", "update_dependency", "add_comment"]);
    expect(allValid(s?.steps ?? [])).toBe(true);
    expect(s?.steps.map((x) => x.required)).toEqual([true, false, false]);
    expect(s?.steps[0]?.payload).toMatchObject({
      intent: "chase",
      recipientPersonId: null,
      recipientTeamId: "t-platform",
      issueKeys: ["PAY-12"],
    });
    expect(notesOf(s, 0)).toContain("Chase the new cert");
    expect(s?.steps[1]?.payload).toMatchObject({
      action: "reschedule",
      nextFollowupAt: addBusinessDays(TODAY, 3),
    });
    expect(s?.keys).toEqual(["PAY-12"]);
  });

  test("a chase since the last follow-up, an away owner or a later date: nothing", () => {
    const chased = event({
      kind: "wait_chased",
      actor: "me",
      at: "2026-10-18T09:00:00.000Z",
      data: { dependencyId: "w-plat" },
    });
    expect(waitUnanswered(input({ waits: [due], history: [chased] }))).toEqual([]);
    expect(
      waitUnanswered(
        input({ waits: [{ ...due, ownerAway: { name: "Platform", awayUntil: "2026-10-23" } }] }),
      ),
    ).toEqual([]);
    expect(waitUnanswered(input({ waits: [{ ...due, nextFollowupAt: "2026-10-20" }] }))).toEqual(
      [],
    );
  });

  test("the key moves with the follow-up date", () => {
    const a = waitUnanswered(input({ waits: [due] }))[0]?.key;
    const b = waitUnanswered(input({ waits: [{ ...due, nextFollowupAt: "2026-10-16" }] }))[0]?.key;
    expect(a).not.toBe(b ?? "");
  });
});

describe("the rules together", () => {
  test("in priority order", () => {
    const all = runRules(
      moved({
        waits: [wait("w-plat", { nextFollowupAt: "2026-10-18" })],
        newEvents: [event({ data: { text: "Any news?" } })],
      }),
    );
    expect(all.map((s) => s.rule)).toEqual([
      "expected_date_moved",
      "teammate_touched",
      "wait_unanswered",
    ]);
    // The chase plans its own follow-up date, which no earlier step sets.
    expect(kinds(all[2]?.steps ?? [])).toEqual([
      "draft_message",
      "update_dependency",
      "add_comment",
    ]);
    expect(all[2]?.steps[1]?.payload).toMatchObject({
      summary: expect.stringMatching(/^Follow-up planned for /),
    });
  });

  test("quiet after two dismissals, until asked again", () => {
    const e = (id: string, kind: string, rule: string) => ({ id, kind, data: { rule } });
    expect([...quietRules([e("1", "outcome_dismissed", "wait_unanswered")])]).toEqual([]);
    expect([
      ...quietRules([
        e("1", "outcome_dismissed", "wait_unanswered"),
        e("2", "outcome_dismissed", "wait_unanswered"),
        e("3", "outcome_dismissed", "blocker_closed"),
      ]),
    ]).toEqual(["wait_unanswered"]);
    expect([
      ...quietRules([
        e("1", "outcome_dismissed", "wait_unanswered"),
        e("2", "outcome_dismissed", "wait_unanswered"),
        e("3", "rule_resumed", "wait_unanswered"),
        e("4", "outcome_dismissed", "wait_unanswered"),
      ]),
    ]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Phase 26: the rules whose steps grew (chase_due, wait_resolved) and ticket_done
// ---------------------------------------------------------------------------

const instructions = (
  p: Partial<ReturnType<typeof defaultSettings>["secretary"]["instructions"]>,
) => {
  const s = defaultSettings();
  return {
    ...s,
    secretary: { ...s.secretary, instructions: { ...s.secretary.instructions, ...p } },
  };
};

describe("chase_due (wait_unanswered, Phase 26)", () => {
  const due = wait("w-plat", {
    nextFollowupAt: "2026-10-17",
    lastFollowupAt: "2026-10-14T09:00:00.000Z",
    expectedAt: "2026-10-24",
  });

  test("a comment that it still waits, from a template", () => {
    const [s] = waitUnanswered(input({ waits: [due] }));
    expect(s?.steps[2]?.payload).toEqual({
      kind: "add_comment",
      target: "PAY-12",
      bodyMd: "Still waiting on Platform for the new cert, expected 24 Oct.",
    });
  });

  test("no comment when the instruction is off", () => {
    const [s] = waitUnanswered(
      input({ waits: [due], settings: instructions({ commentWaits: false }) }),
    );
    expect(kinds(s?.steps ?? [])).toEqual(["draft_message", "update_dependency"]);
  });

  test("no comment when the user commented on the ticket within the chase interval", () => {
    const said = event({
      kind: "proposal_executed",
      actor: "me",
      at: "2026-10-16T09:00:00.000Z",
      data: { proposalKind: "add_comment", keys: ["PAY-12"] },
    });
    const [recent] = waitUnanswered(input({ waits: [due], history: [said] }));
    expect(kinds(recent?.steps ?? [])).toEqual(["draft_message", "update_dependency"]);
    // An older comment is past the interval (3 working days): it is said again.
    const old = { ...said, at: "2026-10-08T09:00:00.000Z" };
    const [stale] = waitUnanswered(input({ waits: [due], history: [old] }));
    expect(kinds(stale?.steps ?? [])).toContain("add_comment");
  });
});

describe("blocker_closed remembers where a playbook moved the ticket from (Phase 26)", () => {
  test("back to the status the wait remembers, not the project's in-progress one", () => {
    const blocked = facts([
      ticket("PAY-12", { status: "Blocked", blockedBy: ["PLAT-812"] }),
      ticket("PLAT-812", { role: "related", status: "Done", statusCategory: "done" }),
    ]);
    const [s] = blockerClosed(
      input({
        facts: blocked,
        blockedBy: { "PAY-12": ["PLAT-812"] },
        waits: [
          wait("w-plat", {
            externalRef: "PLAT-812",
            data: { blocked: { issueKey: "PAY-12", from: "In Review", to: "Blocked" } },
          }),
        ],
        newEvents: [
          event({
            kind: "jira_change",
            actor: "sync",
            issueKey: "PLAT-812",
            data: { field: "status", from: "In Progress", to: "Done" },
          }),
        ],
      }),
    );
    expect(s?.steps[0]?.payload).toEqual({
      kind: "transition_issue",
      target: "PAY-12",
      toStatus: "In Review",
    });
  });
});

describe("ticket_done (Phase 26)", () => {
  const done = facts([
    ticket("PAY-12", { status: "Done", statusCategory: "done", summary: "Export the Q3 report" }),
  ]);
  // The user's own move in Jira (the change names them).
  const closed = event({
    kind: "jira_change",
    actor: "jira:rick",
    data: { field: "status", from: "In Progress", to: "Done" },
  });
  const requesters = { "PAY-12": { personId: "c-dana", name: "Dana Lee", askedOn: "2026-10-02" } };

  test("resolves its open waits, notes who asked and when, and tells them", () => {
    const [s, ...rest] = ticketDone(
      input({ facts: done, newEvents: [closed], waits: [wait("w-plat")], requesters }),
    );
    expect(rest).toEqual([]);
    expect(s?.rule).toBe("ticket_done");
    expect(kinds(s?.steps ?? [])).toEqual(["update_dependency", "add_comment", "draft_message"]);
    expect(allValid(s?.steps ?? [])).toBe(true);
    expect(s?.steps[0]?.payload).toMatchObject({ dependencyId: "w-plat", action: "resolve" });
    expect(s?.steps[1]?.payload).toMatchObject({
      target: "PAY-12",
      bodyMd: "Done; Dana Lee asked for this on 2 Oct.",
    });
    expect(s?.steps[2]?.payload).toMatchObject({
      recipientPersonId: "c-dana",
      intent: "status_update",
      issueKeys: ["PAY-12"],
    });
    expect(s?.waits).toEqual(["w-plat"]);
  });

  test("only the user's own move counts: a sync change by someone unknown does not", () => {
    const bySync = { ...closed, id: "01EVSYNC", actor: "sync" };
    const byAna = { ...closed, id: "01EVANA", actor: "jira:ana.b" };
    expect(ticketDone(input({ facts: done, newEvents: [bySync, byAna], requesters }))).toEqual([]);
    const edited = { ...closed, id: "01EVME", kind: "ticket_edited", actor: "me" };
    expect(ticketDone(input({ facts: done, newEvents: [edited], requesters }))).toHaveLength(1);
  });

  test("an approved move into done counts; no requester and no wait means no card", () => {
    const moved = event({
      kind: "proposal_executed",
      actor: "me",
      data: { proposalKind: "transition_issue", keys: ["PAY-12"] },
    });
    expect(ticketDone(input({ facts: done, newEvents: [moved], requesters }))).toHaveLength(1);
    expect(ticketDone(input({ facts: done, newEvents: [moved] }))).toEqual([]);
  });

  test("only a primary ticket that is done now, and no comment while the instruction is off", () => {
    const open = facts([ticket("PAY-12")]);
    expect(ticketDone(input({ facts: open, newEvents: [closed], requesters }))).toEqual([]);
    const related = facts([
      ticket("PAY-12", { role: "related", status: "Done", statusCategory: "done" }),
    ]);
    expect(ticketDone(input({ facts: related, newEvents: [closed], requesters }))).toEqual([]);
    const [quiet] = ticketDone(
      input({
        facts: done,
        newEvents: [closed],
        requesters,
        settings: instructions({ commentWaits: false }),
      }),
    );
    expect(kinds(quiet?.steps ?? [])).toEqual(["draft_message"]);
  });

  test("runs with the rules, and its switch turns it off", () => {
    const all = runRules(input({ facts: done, newEvents: [closed], requesters }));
    expect(all.map((s) => s.rule)).toEqual(["ticket_done"]);
    const s = defaultSettings();
    const off = {
      ...s,
      secretary: { ...s.secretary, rules: { ...s.secretary.rules, ticket_done: false } },
    };
    expect(
      runRules(input({ facts: done, newEvents: [closed], requesters, settings: off })),
    ).toEqual([]);
  });
});

describe("blocker_closed after a wait_resolved bundle (Phase 26)", () => {
  test("a ticket whose wait on the blocker a wait_resolved bundle handled is not offered again", () => {
    const blocked = facts([
      ticket("PAY-12", { status: "Blocked", blockedBy: ["PLAT-812"] }),
      ticket("PLAT-812", { role: "related", status: "Done", statusCategory: "done" }),
    ]);
    const base = {
      facts: blocked,
      blockedBy: { "PAY-12": ["PLAT-812"] },
      newEvents: [
        event({
          kind: "jira_change",
          actor: "sync",
          issueKey: "PLAT-812",
          data: { field: "status", from: "In Progress", to: "Done" },
        }),
      ],
    };
    expect(blockerClosed(input(base))).toHaveLength(1);
    expect(
      blockerClosed(
        input({
          ...base,
          handledWaits: [{ issueKey: "PAY-12", label: "the cert", externalRef: "PLAT-812" }],
        }),
      ),
    ).toEqual([]);
  });
});

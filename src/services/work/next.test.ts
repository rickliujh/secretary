/** Next moves (FR-19.8, D62): each source, the ranking, the cap and what a page already shows. */
import { describe, expect, test } from "bun:test";
import type { FactTicket, FactWait, ItemFacts } from "./facts";
import {
  bucketOf,
  movesOf,
  NEXT_LIMIT,
  type NextCard,
  type NextHeld,
  type NextItem,
  type NextMove,
  type NextSprint,
  nextMoves,
  rankMoves,
} from "./next";
import { EMPTY_STATE, type WorkState } from "./schema";

const TODAY = "2026-10-21"; // a Wednesday
const SPRINT: NextSprint = { name: "Payments 15", lastDay: "2026-10-23", daysLeft: 3 };

const ticket = (key: string, patch: Partial<FactTicket> = {}): FactTicket => ({
  key,
  role: "primary",
  summary: `Ticket ${key}`,
  status: "In Progress",
  statusCategory: "indeterminate",
  assignee: "Me",
  dueDate: null,
  sprint: null,
  storyPoints: null,
  blockedBy: [],
  unknown: false,
  ...patch,
});
const wait = (id: string, patch: Partial<FactWait> = {}): FactWait => ({
  id,
  issueKey: "PAY-12",
  label: "the cert",
  owner: "Sarah Kim",
  ownerPersonId: "c-sarah",
  status: "waiting",
  requestedAt: "2026-10-14T09:00:00.000Z",
  expectedAt: null,
  nextFollowupAt: null,
  ...patch,
});
const facts = (patch: Partial<ItemFacts> = {}): ItemFacts => ({
  today: TODAY,
  tickets: [],
  waits: [],
  people: [{ id: "c-dana", name: "Dana Lee" }],
  ...patch,
});
const item = (patch: Partial<NextItem> = {}): NextItem => ({
  id: "w1",
  state: null,
  userNote: null,
  noteOn: null,
  ...patch,
});
const withPromise = (dueOn: string | null, patch: Record<string, unknown> = {}): WorkState => ({
  ...EMPTY_STATE,
  commitments: [
    {
      what: "an ETA for the cert",
      toPersonId: "c-dana",
      toName: null,
      dueOn,
      saidIn: "e1",
      status: "open",
      ...patch,
    },
  ],
});
const card = (id: string, patch: Partial<NextCard> = {}): NextCard => ({
  id,
  rule: "wait_unanswered",
  title: `Card ${id}`,
  keys: ["PAY-12"],
  waits: [],
  facts: {},
  ...patch,
});
const held = (key: string, patch: Partial<NextHeld> = {}): NextHeld => ({
  rule: "commitment_due",
  key,
  title: `Held ${key}`,
  keys: [],
  waits: [],
  facts: {},
  ...patch,
});

const brief = (moves: readonly NextMove[]) => moves.map((m) => [m.kind, m.on, m.bucket]);

describe("buckets", () => {
  test("overdue, today, before the sprint ends, later; no date is later", () => {
    expect(bucketOf("2026-10-20", TODAY, SPRINT)).toBe("overdue");
    expect(bucketOf(TODAY, TODAY, SPRINT)).toBe("today");
    expect(bucketOf("2026-10-23", TODAY, SPRINT)).toBe("sprint");
    expect(bucketOf("2026-10-24", TODAY, SPRINT)).toBe("later");
    expect(bucketOf("2026-10-22", TODAY, null)).toBe("later");
    expect(bucketOf(null, TODAY, SPRINT)).toBe("later");
  });
});

describe("each source of next moves (D62)", () => {
  test("a pending card is due today, or on the late date it is about", () => {
    const moves = movesOf(
      item(),
      facts(),
      [
        card("o1"),
        card("o2", { rule: "commitment_due", facts: { dueOn: "2026-10-19" }, keys: [] }),
        card("o3", { rule: "wait_unanswered", facts: { due: "2026-10-20" } }),
      ],
      [],
      TODAY,
      SPRINT,
    );
    expect(moves.map((m) => [m.cardId, m.on, m.bucket, m.issueKey])).toEqual([
      ["o1", TODAY, "today", "PAY-12"],
      ["o2", "2026-10-19", "overdue", null],
      ["o3", "2026-10-20", "overdue", "PAY-12"],
    ]);
    expect(moves.every((m) => m.kind === "card")).toBe(true);
  });

  test("a situation an off or quiet rule would raise is a line, not a card", () => {
    const [m] = movesOf(
      item(),
      facts(),
      [],
      [held("commitment_due:w1:x", { title: "Late: an ETA (to Dana Lee)", keys: ["PAY-12"] })],
      TODAY,
      SPRINT,
    );
    expect(m).toMatchObject({ kind: "held", cardId: null, issueKey: "PAY-12", on: TODAY });
    expect(m?.text).toBe("Late: an ETA (to Dana Lee)");
  });

  test("open waits with a follow-up date; resolved or undated ones are not moves", () => {
    const moves = movesOf(
      item(),
      facts({
        waits: [
          wait("d1", { nextFollowupAt: "2026-10-20" }),
          wait("d2", { nextFollowupAt: "2026-10-27", label: "the review", owner: "Omar" }),
          wait("d3"),
          wait("d4", { status: "resolved", nextFollowupAt: "2026-10-20" }),
        ],
      }),
      [],
      [],
      TODAY,
      SPRINT,
    );
    expect(moves.map((m) => [m.waitId, m.text, m.bucket])).toEqual([
      ["d1", "Chase Sarah Kim for the cert", "overdue"],
      ["d2", "Follow up with Omar for the review", "later"],
    ]);
  });

  test("a wait ranks on D47's follow-up day: an away owner's waits until they are back", () => {
    const moves = movesOf(
      item(),
      facts({
        waits: [
          // Chase was due two days ago, but Sarah is away until Monday: due the day after.
          wait("d1", { nextFollowupAt: "2026-10-19", followupOn: "2026-10-27" }),
          // Back since yesterday and not chased: due on the back day.
          wait("d2", { nextFollowupAt: "2026-10-30", followupOn: "2026-10-20", owner: "Omar" }),
        ],
      }),
      [],
      [],
      TODAY,
      SPRINT,
    );
    expect(moves.map((m) => [m.waitId, m.on, m.bucket, m.text])).toEqual([
      ["d1", "2026-10-27", "later", "Follow up with Sarah Kim for the cert"],
      ["d2", "2026-10-20", "overdue", "Chase Omar for the cert"],
    ]);
  });

  test("a wait a card or a held line is about is not listed twice", () => {
    const moves = movesOf(
      item(),
      facts({
        waits: [
          wait("d1", { nextFollowupAt: TODAY }),
          wait("d2", { nextFollowupAt: TODAY }),
          wait("d3", { nextFollowupAt: TODAY }),
        ],
      }),
      [card("o1", { waits: ["d1"] })],
      [held("wait_unanswered:w1:y", { rule: "wait_unanswered", waits: ["d2"] })],
      TODAY,
      SPRINT,
    );
    expect(moves.filter((m) => m.kind === "wait").map((m) => m.waitId)).toEqual(["d3"]);
  });

  test("open commitments with a due date, named by their person", () => {
    const moves = movesOf(
      item({ state: withPromise("2026-10-22") }),
      facts({ tickets: [ticket("PAY-12")] }),
      [],
      [],
      TODAY,
      SPRINT,
    );
    expect(moves).toEqual([
      expect.objectContaining({
        kind: "commitment",
        text: "Promised Dana Lee: an ETA for the cert",
        on: "2026-10-22",
        bucket: "sprint",
        issueKey: "PAY-12",
      }),
    ]);
    // No date, kept or stale: no move.
    for (const s of [
      withPromise(null),
      withPromise("2026-10-22", { status: "kept" }),
      withPromise("2026-10-22", { status: "stale" }),
    ])
      expect(movesOf(item({ state: s }), facts(), [], [], TODAY, SPRINT)).toEqual([]);
  });

  test("a promise a commitment_due card or line is about is not listed twice", () => {
    const state = withPromise("2026-10-19");
    const facts1 = { saidIn: "e1", what: "an ETA for the cert", dueOn: "2026-10-19" };
    expect(
      movesOf(
        item({ state }),
        facts(),
        [card("o1", { rule: "commitment_due", facts: facts1 })],
        [],
        TODAY,
        SPRINT,
      ).map((m) => m.kind),
    ).toEqual(["card"]);
    expect(
      movesOf(item({ state }), facts(), [], [held("k", { facts: facts1 })], TODAY, SPRINT).map(
        (m) => m.kind,
      ),
    ).toEqual(["held"]);
  });

  test("primary tickets with a due date, or in a sprint ending within three working days", () => {
    const tickets = [
      ticket("PAY-1", { dueDate: "2026-10-30" }),
      ticket("PAY-2", { sprint: "Payments 15" }),
      ticket("PAY-3", { sprint: "Payments 15", dueDate: "2026-10-30" }),
      ticket("PAY-4", { sprint: "Payments 15", dueDate: "2026-10-22" }),
      ticket("PAY-5", { dueDate: "2026-10-20", statusCategory: "done" }),
      ticket("PLAT-8", { role: "related", dueDate: "2026-10-20" }),
      ticket("PAY-6"),
    ];
    const moves = movesOf(item(), facts({ tickets }), [], [], TODAY, SPRINT);
    expect(moves.map((m) => [m.issueKey, m.on, m.bucket, m.text])).toEqual([
      ["PAY-1", "2026-10-30", "later", "PAY-1 is due: Ticket PAY-1"],
      ["PAY-2", "2026-10-23", "sprint", "PAY-2 before the sprint ends: Ticket PAY-2"],
      // Due after the sprint it is in ends: the sprint's end is what counts.
      ["PAY-3", "2026-10-23", "sprint", "PAY-3 before the sprint ends: Ticket PAY-3"],
      ["PAY-4", "2026-10-22", "sprint", "PAY-4 is due: Ticket PAY-4"],
    ]);
    // A sprint with more room left: only due dates count.
    const roomy = { ...SPRINT, daysLeft: 6, lastDay: "2026-10-28" };
    expect(
      movesOf(item(), facts({ tickets }), [], [], TODAY, roomy).map((m) => m.issueKey),
    ).toEqual(["PAY-1", "PAY-3", "PAY-4"]);
  });

  test("the user's own note when it names a date; the secretary's note never", () => {
    const note = "Cert comes from Sarah on Friday; then I install it.";
    const [m] = movesOf(item({ userNote: note, noteOn: TODAY }), facts(), [], [], TODAY, SPRINT);
    expect(m).toMatchObject({ kind: "note", on: "2026-10-23", bucket: "sprint" });
    expect(m?.text).toBe(`Your note: ${note}`);
    expect(
      movesOf(
        item({ userNote: "Installing it, no rush", noteOn: TODAY }),
        facts(),
        [],
        [],
        TODAY,
        SPRINT,
      ),
    ).toEqual([]);
    expect(movesOf(item({ userNote: null }), facts(), [], [], TODAY, SPRINT)).toEqual([]);
  });
});

describe("ranking (D62)", () => {
  test("overdue, today, before the sprint ends, then the rest by date; at most five", () => {
    const moves = nextMoves(
      item({ state: withPromise("2026-10-22") }),
      facts({
        tickets: [
          ticket("PAY-1", { dueDate: "2026-11-05" }),
          ticket("PAY-2", { dueDate: "2026-10-30" }),
          ticket("PAY-3", { sprint: "Payments 15" }),
        ],
        waits: [wait("d1", { nextFollowupAt: "2026-10-17" })],
      }),
      [card("o1")],
      [],
      TODAY,
      SPRINT,
    );
    expect(brief(moves)).toEqual([
      ["wait", "2026-10-17", "overdue"],
      ["card", TODAY, "today"],
      ["commitment", "2026-10-22", "sprint"],
      ["ticket", "2026-10-23", "sprint"],
      ["ticket", "2026-10-30", "later"],
    ]);
    expect(moves).toHaveLength(NEXT_LIMIT);
  });

  test("on the same day a card comes before a line", () => {
    const moves = nextMoves(
      item(),
      facts({ waits: [wait("d1", { nextFollowupAt: TODAY })] }),
      [card("o1", { keys: [] })],
      [held("h1")],
      TODAY,
      SPRINT,
    );
    expect(moves.map((m) => m.kind)).toEqual(["card", "held", "wait"]);
  });

  test("the current item's moves come first when items are combined", () => {
    const mine = movesOf(
      item({ id: "cur" }),
      facts({ tickets: [ticket("A-1", { dueDate: "2026-11-30" })] }),
      [],
      [],
      TODAY,
      SPRINT,
    );
    const other = movesOf(
      item({ id: "oth" }),
      facts({ tickets: [ticket("B-1", { dueDate: "2026-10-01" })] }),
      [],
      [],
      TODAY,
      SPRINT,
    );
    expect(rankMoves([...other, ...mine], { currentItemId: "cur" }).map((m) => m.issueKey)).toEqual(
      ["A-1", "B-1"],
    );
    expect(rankMoves([...mine, ...other]).map((m) => m.issueKey)).toEqual(["B-1", "A-1"]);
  });
});

/**
 * Next moves (FR-19.8, D62), pure: what the user can do next on a work item,
 * derived by code from dates the app already holds, never by a model. The
 * sources are the item's pending outcome cards (Phase 25), the situations its
 * rules would raise but do not because the rule is off or quiet (a line, not a
 * card), open waits with a follow-up date, open commitments with a due date,
 * primary tickets with a due date or in a sprint that ends within three working
 * days (D57's room line), and the user's own status note when it names a date.
 *
 * Ranking: overdue first, then due today, then due before the sprint ends, then
 * the rest by date; at most five, the current item's first.
 */
import { datesInText } from "./dates";
import type { ItemFacts } from "./facts";
import type { SituationKind, WorkState } from "./schema";

/** Most moves shown in one place. */
export const NEXT_LIMIT = 5;

/** A ticket in a sprint that ends within this many working days is a move. */
export const SPRINT_SOON_DAYS = 3;

export type NextBucket = "overdue" | "today" | "sprint" | "later";
const BUCKETS: readonly NextBucket[] = ["overdue", "today", "sprint", "later"];

export type NextKind = "card" | "held" | "commitment" | "wait" | "ticket" | "note";
const KINDS: readonly NextKind[] = ["card", "held", "commitment", "wait", "ticket", "note"];

export type NextMove = {
  /** Stable within an item, for lists. */
  id: string;
  kind: NextKind;
  itemId: string;
  text: string;
  /** The date it is due by (YYYY-MM-DD); null when none is known. */
  on: string | null;
  bucket: NextBucket;
  /** The ticket it is about, opened with one click. */
  issueKey: string | null;
  /** The outcome card (`kind` card), opened in the Inbox. */
  cardId: string | null;
  /** The wait it is about, if any. */
  waitId: string | null;
};

/** A pending outcome card of the item, as `pendingOutcomes` lists it. */
export type NextCard = {
  id: string;
  rule: SituationKind;
  title: string;
  keys: readonly string[];
  waits: readonly string[];
  facts?: Readonly<Record<string, unknown>>;
};

/** A situation a switched-off or quiet rule would raise (`heldOfItem`). */
export type NextHeld = {
  rule: SituationKind;
  key: string;
  title: string;
  keys: readonly string[];
  waits: readonly string[];
  facts: Readonly<Record<string, unknown>>;
};

/** The user's active sprint: its last working day and the working days left (D57). */
export type NextSprint = { name: string; lastDay: string; daysLeft: number } | null;

export type NextItem = {
  id: string;
  state: WorkState | null;
  /** The status note the user wrote, while it holds; null when the note is the secretary's. */
  userNote: string | null;
  /** The local day the user wrote it. */
  noteOn: string | null;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const asDate = (v: unknown) => (typeof v === "string" && DATE.test(v) ? v : null);

/** Which bucket a date falls in. */
export function bucketOf(on: string | null, today: string, sprint: NextSprint): NextBucket {
  if (!on) return "later";
  if (on < today) return "overdue";
  if (on === today) return "today";
  if (sprint && on <= sprint.lastDay) return "sprint";
  return "later";
}

/**
 * A card waits on the user's decision, so it is due today; one about a date
 * that has passed (a promise, a chase) is overdue.
 */
const cardDate = (facts: Readonly<Record<string, unknown>> | undefined, today: string) => {
  const d = asDate(facts?.dueOn) ?? asDate(facts?.due);
  return d && d < today ? d : today;
};

/** Every move of one item, unranked and uncapped. */
export function movesOf(
  item: NextItem,
  facts: ItemFacts,
  cards: readonly NextCard[],
  situations: readonly NextHeld[],
  today: string,
  sprint: NextSprint,
): NextMove[] {
  const out: NextMove[] = [];
  const add = (m: Omit<NextMove, "itemId" | "bucket">) =>
    out.push({ ...m, itemId: item.id, bucket: bucketOf(m.on, today, sprint) });

  const coveredWaits = new Set([...cards, ...situations].flatMap((c) => c.waits));
  const promised = new Set(
    [...cards, ...situations]
      .filter((c) => c.rule === "commitment_due")
      .map((c) => `${c.facts?.saidIn}|${c.facts?.what}`),
  );

  for (const c of cards)
    add({
      id: `card:${c.id}`,
      kind: "card",
      text: c.title,
      on: cardDate(c.facts, today),
      issueKey: c.keys[0] ?? null,
      cardId: c.id,
      waitId: c.waits[0] ?? null,
    });

  for (const s of situations)
    add({
      id: `held:${s.key}`,
      kind: "held",
      text: s.title,
      on: cardDate(s.facts, today),
      issueKey: s.keys[0] ?? null,
      cardId: null,
      waitId: s.waits[0] ?? null,
    });

  const names = new Map(facts.people.map((p) => [p.id, p.name]));
  const primary = facts.tickets.filter((t) => t.role === "primary" && !t.unknown);
  for (const c of item.state?.commitments ?? []) {
    if (c.status !== "open" || !c.dueOn) continue;
    if (promised.has(`${c.saidIn}|${c.what}`)) continue;
    const to = (c.toPersonId && names.get(c.toPersonId)) || c.toName || "someone";
    add({
      id: `commitment:${c.saidIn}:${c.what}`,
      kind: "commitment",
      text: `Promised ${to}: ${c.what}`,
      on: c.dueOn,
      issueKey: primary[0]?.key ?? null,
      cardId: null,
      waitId: null,
    });
  }

  for (const w of facts.waits) {
    // D47's timing: an away owner's wait is due the day they are back, not before.
    const on = w.followupOn !== undefined ? w.followupOn : w.nextFollowupAt;
    if (w.status === "resolved" || !on || coveredWaits.has(w.id)) continue;
    const due = on <= today;
    add({
      id: `wait:${w.id}`,
      kind: "wait",
      text: `${due ? "Chase" : "Follow up with"} ${w.owner} for ${w.label}`,
      on,
      issueKey: w.issueKey,
      cardId: null,
      waitId: w.id,
    });
  }

  for (const t of primary) {
    if (t.statusCategory === "done") continue;
    const ending =
      !!sprint && !!t.sprint && t.sprint === sprint.name && sprint.daysLeft <= SPRINT_SOON_DAYS;
    const due = t.dueDate && (!ending || !sprint || t.dueDate <= sprint.lastDay) ? t.dueDate : null;
    if (!due && !ending) continue;
    const what = t.summary ? `: ${t.summary}` : "";
    add({
      id: `ticket:${t.key}`,
      kind: "ticket",
      text: due ? `${t.key} is due${what}` : `${t.key} before the sprint ends${what}`,
      on: due ?? sprint?.lastDay ?? null,
      issueKey: t.key,
      cardId: null,
      waitId: null,
    });
  }

  if (item.userNote) {
    const from = item.noteOn ?? today;
    const date = datesInText(item.userNote, from).find((d) => d >= from);
    if (date)
      add({
        id: "note",
        kind: "note",
        text: `Your note: ${item.userNote.replace(/\s+/g, " ").trim().slice(0, 120)}`,
        on: date,
        issueKey: null,
        cardId: null,
        waitId: null,
      });
  }
  return out;
}

/**
 * Ranks moves (D62): the current item's first, then overdue, due today, due
 * before the sprint ends and the rest; by date within each, then cards before
 * lines. At most `limit`.
 */
export function rankMoves(
  moves: readonly NextMove[],
  opts: { currentItemId?: string | null; limit?: number } = {},
): NextMove[] {
  const current = (m: NextMove) => Number(!!opts.currentItemId && m.itemId === opts.currentItemId);
  return [...moves]
    .sort(
      (a, b) =>
        current(b) - current(a) ||
        BUCKETS.indexOf(a.bucket) - BUCKETS.indexOf(b.bucket) ||
        (a.on ?? "9999").localeCompare(b.on ?? "9999") ||
        KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) ||
        a.text.localeCompare(b.text),
    )
    .slice(0, opts.limit ?? NEXT_LIMIT);
}

/** The next moves of one item, ranked and capped. */
export function nextMoves(
  item: NextItem,
  facts: ItemFacts,
  cards: readonly NextCard[],
  situations: readonly NextHeld[],
  today: string,
  sprint: NextSprint,
  limit = NEXT_LIMIT,
): NextMove[] {
  return rankMoves(movesOf(item, facts, cards, situations, today, sprint), { limit });
}

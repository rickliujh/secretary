/**
 * The end-of-day pass (FR-19.9, D63), pure: one markdown page code writes from
 * what the app already holds, never a model. For each active item with events
 * today, what changed (one line per event, the user's own words first, others'
 * words quoted), its current step and what is expected next; for tomorrow (the
 * next business day: Friday's tomorrow is Monday), the tickets due, the waits
 * whose follow-up falls, the promises due, drafts left unsent for more than a
 * day, and the outcome cards still waiting, by item. The questions the rules
 * could not settle are listed beside the page with their choices
 * (`dayend-query.ts` releases them); the page only counts them.
 */
import { addBusinessDays, localDate } from "@/lib/dates";
import type { ItemFacts } from "./facts";
import type { WorkState } from "./schema";

/** Lines of one item's "what changed" before the rest is counted. */
export const DAY_END_EVENT_LINES = 8;
/** Most questions one day's page releases. */
export const DAY_END_QUESTIONS = 5;
/** Characters that format markdown (or start an entity or an autolink), escaped in quotes. */
const MD_SPECIAL = /[\\`*_{}[\]()#+\-.!|<>~&:]/g;
const MD_ESCAPED = /\\([\\`*_{}[\]()#+\-.!|<>~&:])/g;
/** Zero-width joiner, which stops an autolink without changing what the user reads. */
const ZWJ = "\u200d";
/** Characters of someone's words quoted on one line. */
const QUOTE_CHARS = 160;
/** A draft unsent this long is listed (ms). */
const DRAFT_AGE_MS = 24 * 3600 * 1000;

export type DayEndItem = {
  id: string;
  name: string;
  current: boolean;
  state: WorkState | null;
  /** The last state update failed code's checks (D61). */
  needsLook: boolean;
};

/** One of today's events on an item, as the page shows it. */
export type DayEndEvent = {
  itemId: string;
  kind: string;
  /** ISO time, for the order. */
  at: string;
  /** Local HH:MM. */
  time: string;
  /** "Ana Bell", "Jira", "someone"; the user's own events say "You". */
  actor: string;
  /** Code's words for it (never someone's pasted words, D61). */
  summary: string;
  /** The words of the event (a comment, a quote, a note), if any. */
  text: string;
  /** The user's own words: a note, an answer, their typed input. */
  ownWords: boolean;
  /** The user did it (an approval, a sent draft): no quote, their words are known. */
  mine: boolean;
};

export type DayEndDraft = {
  id: string;
  intent: string;
  recipient: string | null;
  issueKeys: readonly string[];
  /** ISO time it was made. */
  createdAt: string;
  /** The active item its first ticket belongs to, if any. */
  itemId: string | null;
};

export type DayEndCard = { id: string; itemId: string | null; itemName: string; title: string };

export type DayEndInput = {
  /** The local day the pass runs on. */
  today: string;
  /** Now, ISO: drafts older than a day are listed. */
  now: string;
  /** The active items. */
  items: readonly DayEndItem[];
  events: readonly DayEndEvent[];
  /** Each active item's facts (tickets, waits). */
  facts: ReadonlyMap<string, ItemFacts>;
  /** Drafts not marked sent. */
  drafts: readonly DayEndDraft[];
  /** Pending outcome cards. */
  cards: readonly DayEndCard[];
  /** Contacts by id, for whom a promise was made to; the facts' people otherwise. */
  contacts?: ReadonlyMap<string, string>;
  /** The questions listed beside the page, by item (null: not about one item). */
  questions: readonly { itemId: string | null }[];
};

export type DayEndPage = {
  markdown: string;
  /** "Mon 19 Oct" */
  title: string;
  /** The next business day. */
  tomorrow: string;
  /** Every item the page names, for its `day_end` event. */
  itemIds: string[];
  /** Lines per section, for the chat and the tests. */
  counts: {
    changed: number;
    due: number;
    followups: number;
    promises: number;
    drafts: number;
    cards: number;
    questions: number;
  };
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Mon 20 Oct" for a YYYY-MM-DD day, the same on every machine. */
export function dayLabel(date: string): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** The next business day after `today` (Friday, Saturday and Sunday give Monday). */
export const tomorrowOf = (today: string) => addBusinessDays(today, 1);

/**
 * Someone's words on one line of the page: whitespace folded, clipped, and
 * every markdown character escaped, so a quote can neither format the page nor
 * embed an image or a link.
 */
export function inlineText(text: string, max = QUOTE_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const clipped = flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
  // Belt and braces beside the page's text-only links: a zero-width joiner
  // breaks what GFM would autolink (a scheme, a www. host, an email).
  const unlinked = clipped
    .replace(/:\/\//g, `:${ZWJ}//`)
    .replace(/www\./gi, (w) => `${w.slice(0, 3)}${ZWJ}.`)
    .replace(/@/g, `${ZWJ}@${ZWJ}`);
  return unlinked.replace(MD_SPECIAL, (c) => `\\${c}`);
}

/** The page as plain text for the chat: the escapes `inlineText` added taken out. */
export const plainPage = (markdown: string) =>
  markdown.replace(MD_ESCAPED, "$1").replaceAll(ZWJ, "");

/** When a date falls against today: "overdue since Fri 16 Oct", "today", "Tue 20 Oct". */
const when = (on: string, today: string) =>
  on < today ? `overdue since ${dayLabel(on)}` : on === today ? "today" : dayLabel(on);

const eventLine = (e: DayEndEvent) => {
  if (e.ownWords) {
    const words = e.text.trim() ? inlineText(e.text) : inlineText(e.summary);
    return `- ${e.time} You: ${words}`;
  }
  if (e.mine) return `- ${e.time} ${inlineText(e.summary, 200)}`;
  const quote = e.text.trim() ? `: “${inlineText(e.text)}”` : "";
  return `- ${e.time} ${inlineText(e.summary, 200)}${quote}`;
};

/** The page (D63). */
export function dayEnd(input: DayEndInput): DayEndPage {
  const { today } = input;
  const tomorrow = tomorrowOf(today);
  const names = new Map(input.items.map((i) => [i.id, i.name]));
  const listed = new Set<string>();
  const out: string[] = [`# End of day, ${dayLabel(today)}`];

  // What changed today, item by item: the current item first, then the latest news.
  const byItem = new Map<string, DayEndEvent[]>();
  for (const e of input.events)
    if (names.has(e.itemId)) byItem.set(e.itemId, [...(byItem.get(e.itemId) ?? []), e]);
  const latest = (id: string) => (byItem.get(id) ?? []).reduce((m, e) => (e.at > m ? e.at : m), "");
  const changed = input.items
    .filter((i) => byItem.has(i.id))
    .sort(
      (a, b) =>
        Number(b.current) - Number(a.current) ||
        latest(b.id).localeCompare(latest(a.id)) ||
        a.name.localeCompare(b.name),
    );
  out.push("", "## What changed today");
  if (changed.length === 0) out.push("", "Nothing new on your work items today.");
  for (const item of changed) {
    listed.add(item.id);
    const events = [...(byItem.get(item.id) ?? [])].sort(
      (a, b) =>
        Number(b.ownWords) - Number(a.ownWords) ||
        Number(b.mine) - Number(a.mine) ||
        a.at.localeCompare(b.at),
    );
    out.push("", `### ${item.current ? "★ " : ""}${inlineText(item.name, 200)}`, "");
    for (const e of events.slice(0, DAY_END_EVENT_LINES)) out.push(eventLine(e));
    if (events.length > DAY_END_EVENT_LINES)
      out.push(`- and ${events.length - DAY_END_EVENT_LINES} more on the item's timeline`);
    const state = item.state;
    const where: string[] = [];
    if (state?.currentStep) where.push(`**Now:** ${inlineText(state.currentStep, 200)}`);
    if (state?.nextExpected)
      where.push(
        `**Next expected:** ${inlineText(state.nextExpected.what, 200)}${
          state.nextExpected.on ? ` (${dayLabel(state.nextExpected.on)})` : ""
        }`,
      );
    if (item.needsLook)
      where.push("**Status note:** needs your look; the last update did not check out.");
    if (where.length) out.push("", where.join("  \n"));
  }

  // Tomorrow, across the active items.
  const of = (id: string | null) =>
    id && names.has(id) ? ` (${inlineText(names.get(id) ?? "", 120)})` : "";
  const due: string[] = [];
  const followups: string[] = [];
  const promises: string[] = [];
  for (const item of input.items) {
    const facts = input.facts.get(item.id);
    if (!facts) continue;
    for (const t of facts.tickets) {
      if (t.role !== "primary" || t.unknown || t.statusCategory === "done") continue;
      if (!t.dueDate || t.dueDate > tomorrow) continue;
      listed.add(item.id);
      due.push(
        `- ${t.key}${t.summary ? ` ${inlineText(t.summary, 120)}` : ""}, due ${when(t.dueDate, today)}${of(item.id)}`,
      );
    }
    for (const w of facts.waits) {
      const on = w.followupOn !== undefined ? w.followupOn : w.nextFollowupAt;
      if (w.status === "resolved" || !on || on > tomorrow) continue;
      listed.add(item.id);
      followups.push(
        `- Follow up with ${inlineText(w.owner, 80)} for ${inlineText(w.label, 120)} on ${w.issueKey}, ${
          on < today ? `due since ${dayLabel(on)}` : on === today ? "due today" : dayLabel(on)
        }${of(item.id)}`,
      );
    }
    const people = new Map([
      ...facts.people.map((p) => [p.id, p.name] as const),
      ...(input.contacts ?? []),
    ]);
    for (const c of item.state?.commitments ?? []) {
      if (c.status !== "open" || !c.dueOn || c.dueOn > tomorrow) continue;
      listed.add(item.id);
      const to = (c.toPersonId && people.get(c.toPersonId)) || c.toName || "someone";
      promises.push(
        `- To ${inlineText(to, 80)}: ${inlineText(c.what, 160)}, due ${when(c.dueOn, today)}${of(item.id)}`,
      );
    }
  }
  const nowMs = Date.parse(input.now);
  const drafts = input.drafts
    .filter((d) => nowMs - Date.parse(d.createdAt) > DRAFT_AGE_MS)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((d) => {
      if (d.itemId && names.has(d.itemId)) listed.add(d.itemId);
      const keys = d.issueKeys.length ? ` about ${d.issueKeys.slice(0, 3).join(", ")}` : "";
      const to = d.recipient ? ` to ${inlineText(d.recipient, 80)}` : "";
      const kind = d.intent.replace(/_/g, " ");
      return `- ${kind.charAt(0).toUpperCase()}${kind.slice(1)}${to}${keys}, written ${dayLabel(localDate(new Date(d.createdAt)))}${of(d.itemId)}`;
    });
  const cardsBy = new Map<string, DayEndCard[]>();
  for (const c of input.cards) {
    const name = (c.itemId && names.get(c.itemId)) || c.itemName || "Other work";
    if (c.itemId && names.has(c.itemId)) listed.add(c.itemId);
    cardsBy.set(name, [...(cardsBy.get(name) ?? []), c]);
  }
  const cards = [...cardsBy.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([name, list]) => [
      `- ${inlineText(name, 120)}`,
      ...list.map((c) => `  - ${inlineText(c.title, 160)}`),
    ]);

  out.push("", `## Tomorrow, ${dayLabel(tomorrow)}`);
  const section = (title: string, lines: readonly string[]) => {
    if (lines.length) out.push("", `### ${title}`, "", ...lines);
  };
  section("Tickets due", due);
  section("Follow-ups", followups);
  section("Promises due", promises);
  section("Drafts not sent", drafts);
  section("Follow-ups waiting for your approval", cards);
  if (!due.length && !followups.length && !promises.length && !drafts.length && !cards.length)
    out.push("", "Nothing is due.");

  for (const q of input.questions) if (q.itemId && names.has(q.itemId)) listed.add(q.itemId);
  if (input.questions.length)
    out.push(
      "",
      "## Questions",
      "",
      `${input.questions.length === 1 ? "One question" : `${input.questions.length} questions`} I could not settle on my own ${input.questions.length === 1 ? "is" : "are"} below. Each is also in its work item's thread.`,
    );

  return {
    markdown: `${out.join("\n")}\n`,
    title: dayLabel(today),
    tomorrow,
    itemIds: [...listed],
    counts: {
      changed: changed.length,
      due: due.length,
      followups: followups.length,
      promises: promises.length,
      drafts: drafts.length,
      cards: input.cards.length,
      questions: input.questions.length,
    },
  };
}

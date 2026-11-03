/**
 * Reading the work model (FR-19.5, D61; Phase 24): the `work` block intake's
 * retrieval puts before the candidates, the chat's `work_items` views and
 * `note_work`, and the facts the brief and the report draw from. Code picks
 * every item shown; nothing here calls a model or writes to Jira. `noteWork`
 * is a local write like pin and snooze (D17).
 */
import { and, desc, eq, gte, inArray, ne } from "drizzle-orm";
import { Effect } from "effect";
import { people, workEvents, workItemIssues, workItems } from "@/db/schema";
import { localDate } from "@/lib/dates";
import {
  WORK_EVENT_EXCERPT,
  WORK_EVENT_LIMIT,
  WORK_ITEM_LIMIT,
  type WorkItemSnapshot,
  type WorkReason,
} from "@/prompts/work-block";
import { query } from "@/services/db";
import type { DependencyRow } from "@/services/dependencies/queries";
import { loadItemFacts } from "./facts";
import { derivedNote } from "./note";
import { actorName, ownWords } from "./pass";
import { addNote, setCurrent } from "./queries";
import { eventText, parseState, TIMELINE_ONLY, type WorkState } from "./schema";

const KEY_SCAN = /\b[A-Z][A-Z0-9_]+-\d+\b/g;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** Most tickets, waits and commitments one item shows in the block. */
const BLOCK_TICKETS = 8;
const BLOCK_WAITS = 8;
const BLOCK_COMMITMENTS = 5;
/** Characters of an event's summary in its line. */
const SUMMARY_CHARS = 120;

// ---------------------------------------------------------------------------
// Which items an input reaches (pure)
// ---------------------------------------------------------------------------

export type WorkSignals = {
  /** Keys the input itself names. */
  ownKeys: readonly string[];
  /** The thread's other tickets (named earlier, acted on, created). */
  threadKeys: readonly string[];
  /** Tickets of the sender's open waits. */
  senderWaitKeys: readonly string[];
  /** Tickets of the open waits of contacts the input names. */
  contactWaitKeys: readonly string[];
  /** The current item, offered only when the input is the user's own words and names nothing. */
  currentId: string | null;
};

/**
 * The items the signals reach, at most `limit`, in the order of the signals
 * (D61, Phase 24). The item the user is on comes first among the items named
 * or in the thread when it is one of them, else first among the rest: never
 * ahead of an item the input names or the thread is about.
 */
export function pickWorkItems(
  s: WorkSignals,
  itemOf: (key: string) => string | null,
  isCurrent: (id: string) => boolean = () => false,
  limit = WORK_ITEM_LIMIT,
): { id: string; reasons: WorkReason[] }[] {
  const found = new Map<string, WorkReason[]>();
  const add = (id: string | null, reason: WorkReason) => {
    if (!id) return;
    const r = found.get(id) ?? [];
    if (!r.includes(reason)) r.push(reason);
    found.set(id, r);
  };
  for (const k of s.ownKeys) add(itemOf(k), "named");
  for (const k of s.threadKeys) add(itemOf(k), "thread");
  for (const k of s.senderWaitKeys) add(itemOf(k), "sender");
  for (const k of s.contactWaitKeys) add(itemOf(k), "contact");
  add(s.currentId, "current");
  const all = [...found].map(([id, reasons]) => ({ id, reasons }));
  const currentFirst = (xs: typeof all) => [
    ...xs.filter((x) => isCurrent(x.id)),
    ...xs.filter((x) => !isCurrent(x.id)),
  ];
  const direct = (x: (typeof all)[number]) =>
    x.reasons.includes("named") || x.reasons.includes("thread");
  return [
    ...currentFirst(all.filter(direct)),
    ...currentFirst(all.filter((x) => !direct(x))),
  ].slice(0, limit);
}

/**
 * When "what changed since ..." starts: an ISO time or date, or "this
 * morning", "today", "yesterday", "this week", read by code. Null when the
 * words are none of these.
 */
export function resolveSince(text: string, now = new Date()): string | null {
  const raw = text.trim();
  const t = raw.toLowerCase();
  const day = (offset: number) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
    return d.toISOString();
  };
  if (!t || t === "today" || t === "this morning" || t === "since this morning") return day(0);
  if (t === "yesterday" || t === "since yesterday") return day(-1);
  if (t === "this week") return day(-((now.getDay() + 6) % 7));
  if (t === "last week") return day(-7 - ((now.getDay() + 6) % 7));
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    const [y, m, d] = t.split("-").map(Number);
    return new Date(y ?? 0, (m ?? 1) - 1, d ?? 1).toISOString();
  }
  // Only an ISO time; "Sept 20" or "last Friday" are refused, not guessed.
  if (!ISO_TIME.test(raw)) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

// ---------------------------------------------------------------------------
// Shared loaders
// ---------------------------------------------------------------------------

/** Contact names by id. */
const contactNames = Effect.map(
  query((d) => d.select({ id: people.id, name: people.displayName }).from(people).all()),
  (rows) => new Map(rows.map((p) => [p.id, p.name] as const)),
);

/** Active items by ticket key. */
const activeByKey = Effect.map(
  query((d) =>
    d
      .select({ key: workItemIssues.issueKey, id: workItems.id })
      .from(workItemIssues)
      .innerJoin(workItems, eq(workItems.id, workItemIssues.workItemId))
      .where(eq(workItems.status, "active"))
      .all(),
  ),
  (rows) => new Map(rows.map((r) => [r.key, r.id] as const)),
);

const toName = (
  c: { toPersonId: string | null; toName: string | null },
  names: ReadonlyMap<string, string>,
) => (c.toPersonId && names.get(c.toPersonId)) || c.toName || "someone";

const clip = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

type EventRow = typeof workEvents.$inferSelect;

/** An event as one line of words: its summary, and an excerpt of what was said. */
const eventWords = (e: EventRow, chars = WORK_EVENT_EXCERPT) => {
  const words = eventText(e);
  const summary = clip(e.summary, SUMMARY_CHARS);
  if (!words) return summary;
  // A note's summary is its own first words: say them once.
  const flat = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  if (flat(words).startsWith(flat(e.summary))) return `"${clip(words, chars)}"`;
  return `${summary}: "${clip(words, chars)}"`;
};

/** The last events of an item worth reading (not views or corrections), oldest first. */
const lastEvents = (itemId: string, limit: number, skipInbox?: string) =>
  Effect.map(
    query((d) =>
      d
        .select()
        .from(workEvents)
        .where(eq(workEvents.workItemId, itemId))
        .orderBy(desc(workEvents.at), desc(workEvents.id))
        .limit(limit * 4 + 20)
        .all(),
    ),
    (rows) =>
      rows
        .filter((e) => !TIMELINE_ONLY.has(e.kind as never))
        // The input's own thread is in the prompt already, as the conversation.
        .filter(
          (e) =>
            !skipInbox ||
            e.kind !== "message" ||
            (e.data as { inboxItemId?: string } | null)?.inboxItemId !== skipInbox,
        )
        .slice(0, limit)
        .reverse(),
  );

const openCommitments = (state: WorkState | null) =>
  state?.commitments.filter((c) => c.status === "open") ?? [];

// ---------------------------------------------------------------------------
// The retrieval snapshot's work block (classify, prompt version 15)
// ---------------------------------------------------------------------------

export type WorkBlockRequest = {
  ownKeys: readonly string[];
  /** Every key the item's references hold (its own and the thread's). */
  keys: readonly string[];
  senderPersonId: string | null;
  contactIds: readonly string[];
  /** The user's own words (typed, not the chat's). */
  ownInput: boolean;
  today: string;
  /** The thread the input is in, whose messages the prompt shows already. */
  inboxItemId?: string;
  /** Open waits (`listDependencies()`), read once by retrieval. */
  waits: readonly DependencyRow[];
};

/**
 * The work items an input reaches, with their state, tickets, open waits,
 * open commitments and last events (D61 Reads). Waits are all the items'
 * open waits; retrieval keeps those `waits` offers.
 */
export const loadWorkBlock = (req: WorkBlockRequest) =>
  Effect.gen(function* () {
    const byKey = yield* activeByKey;
    if (byKey.size === 0) return [] as WorkItemSnapshot[];
    const own = new Set(req.ownKeys);
    const open = req.waits.filter((w) => w.status !== "resolved");
    const named = new Set(req.contactIds);
    // The thread's tickets count: "done, thanks" in a thread about PAY-7 is about PAY-7.
    const namesNothing =
      req.ownKeys.length === 0 && req.keys.length === 0 && req.contactIds.length === 0;
    const current = yield* query((d) =>
      d
        .select({ id: workItems.id })
        .from(workItems)
        .where(and(eq(workItems.current, true), eq(workItems.status, "active")))
        .get(),
    );
    const picked = pickWorkItems(
      {
        ownKeys: req.ownKeys,
        threadKeys: req.keys.filter((k) => !own.has(k)),
        senderWaitKeys: req.senderPersonId
          ? open.filter((w) => w.ownerPersonId === req.senderPersonId).map((w) => w.issueKey)
          : [],
        contactWaitKeys: open
          .filter((w) => w.ownerPersonId && named.has(w.ownerPersonId))
          .map((w) => w.issueKey),
        currentId: req.ownInput && namesNothing ? (current?.id ?? null) : null,
      },
      (k) => byKey.get(k) ?? null,
      (id) => id === current?.id,
    );
    if (picked.length === 0) return [] as WorkItemSnapshot[];
    const names = yield* contactNames;
    const rows = yield* query((d) =>
      d
        .select()
        .from(workItems)
        .where(
          inArray(
            workItems.id,
            picked.map((p) => p.id),
          ),
        )
        .all(),
    );
    const out: WorkItemSnapshot[] = [];
    for (const p of picked) {
      const item = rows.find((r) => r.id === p.id);
      if (!item) continue;
      const facts = yield* loadItemFacts(item.id, { today: req.today });
      const state = parseState(item.state);
      const events = yield* lastEvents(item.id, WORK_EVENT_LIMIT, req.inboxItemId);
      out.push({
        id: item.id,
        name: item.name,
        goal: state?.goal ?? item.goal ?? "",
        currentStep: state?.currentStep ?? "",
        nextExpected: state?.nextExpected ?? null,
        current: !!item.current,
        keys: facts.tickets.slice(0, BLOCK_TICKETS).map((t) => ({
          key: t.key,
          status: t.status,
          summary: t.summary,
          role: t.role,
        })),
        waits: facts.waits
          .filter((w) => w.status !== "resolved")
          .slice(0, BLOCK_WAITS)
          .map((w) => ({
            id: w.id,
            issueKey: w.issueKey,
            owner: w.owner,
            label: w.label,
            status: w.status,
            expectedAt: w.expectedAt,
          })),
        commitments: openCommitments(state)
          .slice(0, BLOCK_COMMITMENTS)
          .map((c) => ({
            what: c.what,
            to: toName(c, names),
            dueOn: c.dueOn,
          })),
        lastEvents: events.map((e) => ({
          on: localDate(new Date(e.at)),
          kind: e.kind,
          actor: actorName(e.actor, names),
          text: eventWords(e),
          ownWords: ownWords(e),
        })),
        needsLook: !!item.needsLook,
        reasons: p.reasons,
      });
    }
    return out;
  });

// ---------------------------------------------------------------------------
// The chat (work_items, note_work)
// ---------------------------------------------------------------------------

type ItemRow = typeof workItems.$inferSelect;

/** Items a reference (an id, a ticket key or words of the name) points at; dismissed ones never. */
export const findItems = (ref: string) =>
  Effect.gen(function* () {
    const text = ref.trim();
    if (!text) return [] as ItemRow[];
    const live = yield* query((d) =>
      d.select().from(workItems).where(ne(workItems.status, "dismissed")).all(),
    );
    const byId = live.find((i) => i.id === text);
    if (byId) return [byId];
    const keys = [...new Set(text.toUpperCase().match(KEY_SCAN) ?? [])];
    if (keys.length) {
      const members = yield* query((d) =>
        d.select().from(workItemIssues).where(inArray(workItemIssues.issueKey, keys)).all(),
      );
      const ids = new Set(members.map((m) => m.workItemId));
      return live.filter((i) => ids.has(i.id));
    }
    const words = text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3 && !STOP.has(w));
    if (!words.length) return [];
    const hay = (i: ItemRow) => `${i.name} ${i.goal ?? ""}`.toLowerCase();
    const all = live.filter((i) => words.every((w) => hay(i).includes(w)));
    const matched = all.length ? all : live.filter((i) => words.some((w) => hay(i).includes(w)));
    // An active item wins over a finished one of the same name.
    const active = matched.filter((i) => i.status === "active");
    return active.length ? active : matched;
  });

const STOP = new Set(["the", "and", "for", "with", "work", "item", "on", "my"]);

/** One item as the chat lists it. */
const listEntry = (item: ItemRow, keys: string[]) => {
  const state = parseState(item.state);
  return {
    id: item.id,
    name: item.name,
    current: !!item.current,
    goal: state?.goal || item.goal || null,
    currentStep: state?.currentStep || null,
    nextExpected: state?.nextExpected ?? null,
    openCommitments: openCommitments(state).length,
    tickets: keys,
    ...(item.needsLook ? { needsLook: true } : {}),
  };
};

/** `work_items` list: the active items, the one the user is on first. */
export const workList = Effect.gen(function* () {
  const items = yield* query((d) =>
    d
      .select()
      .from(workItems)
      .where(eq(workItems.status, "active"))
      .orderBy(desc(workItems.current), workItems.name)
      .all(),
  );
  const members = yield* query((d) => d.select().from(workItemIssues).all());
  return items.map((i) =>
    listEntry(
      i,
      members.filter((m) => m.workItemId === i.id).map((m) => m.issueKey),
    ),
  );
});

/** Most events `work_items` item shows. */
export const TIMELINE_LIMIT = 20;

/** `work_items` item: one item's state, tickets, open waits, commitments and last 20 events. */
export const workItemView = (item: ItemRow, today = localDate()) =>
  Effect.gen(function* () {
    const names = yield* contactNames;
    const facts = yield* loadItemFacts(item.id, { today });
    const state = parseState(item.state);
    const events = yield* lastEvents(item.id, TIMELINE_LIMIT);
    return {
      id: item.id,
      name: item.name,
      status: item.status,
      current: !!item.current,
      statusNote: item.noteEditedAt && item.note ? item.note : derivedNote(state, facts, names),
      noteByUser: !!(item.noteEditedAt && item.note),
      ...(item.needsLook
        ? { needsLook: "The last update failed its checks; this state may be out of date." }
        : {}),
      state: state
        ? {
            goal: state.goal || null,
            currentStep: state.currentStep || null,
            nextExpected: state.nextExpected,
            commitments: state.commitments.map((c) => ({
              what: c.what,
              to: toName(c, names),
              dueOn: c.dueOn,
              status: c.status,
            })),
            openQuestions: state.openQuestions,
            people: state.people.map((p) => ({
              name: (p.personId && names.get(p.personId)) || p.name || "someone",
              role: p.role,
            })),
          }
        : null,
      tickets: facts.tickets.map((t) => ({
        key: t.key,
        summary: t.summary,
        status: t.status,
        assignee: t.assignee,
        due: t.dueDate,
        sprint: t.sprint,
        ...(t.role === "related" ? { waitedOn: true } : {}),
        ...(t.blockedBy.length ? { blockedBy: t.blockedBy } : {}),
      })),
      openWaits: facts.waits
        .filter((w) => w.status !== "resolved")
        .map((w) => ({
          issueKey: w.issueKey,
          owner: w.owner,
          label: w.label,
          status: w.status,
          since: w.requestedAt?.slice(0, 10) ?? null,
          expectedAt: w.expectedAt,
          nextChase: w.nextFollowupAt,
        })),
      timeline: events.map((e) => timelineEntry(e, names)),
    };
  });

const timelineEntry = (e: EventRow, names: ReadonlyMap<string, string>) => ({
  at: e.at,
  kind: e.kind,
  by: actorName(e.actor, names),
  ...(e.issueKey ? { ticket: e.issueKey } : {}),
  what: eventWords(e, 300),
});

/** Most events `work_items` changes returns. */
export const CHANGES_LIMIT = 60;

/** `work_items` changes: events since a time, across the active items or for one, by item. */
export const workChanges = (since: string, itemId: string | null) =>
  Effect.gen(function* () {
    const names = yield* contactNames;
    const items = yield* query((d) =>
      d
        .select()
        .from(workItems)
        .where(itemId ? eq(workItems.id, itemId) : eq(workItems.status, "active"))
        .all(),
    );
    if (items.length === 0) return [];
    const rows = (yield* query((d) =>
      d
        .select()
        .from(workEvents)
        .where(
          and(
            gte(workEvents.at, since),
            inArray(
              workEvents.workItemId,
              items.map((i) => i.id),
            ),
          ),
        )
        .orderBy(desc(workEvents.at), desc(workEvents.id))
        .limit(CHANGES_LIMIT * 2)
        .all(),
    ))
      .filter((e) => !TIMELINE_ONLY.has(e.kind as never))
      .slice(0, CHANGES_LIMIT);
    const order = [...new Set(rows.map((e) => e.workItemId ?? ""))];
    return order.flatMap((id) => {
      const item = items.find((i) => i.id === id);
      if (!item) return [];
      return [
        {
          item: item.name,
          id: item.id,
          events: rows
            .filter((e) => e.workItemId === id)
            .reverse()
            .map((e) => timelineEntry(e, names)),
        },
      ];
    });
  });

export type NoteWorkResult =
  | { status: "noted"; itemId: string; item: string; current: boolean }
  | { status: "ask"; reason: "none" | "several"; choices: { id: string; name: string }[] };

/**
 * `note_work` (D61, D17): records the user's words as a `note` event on the one
 * item the text's ticket keys or `ref` reach, and makes it current when they
 * say they are on it. None or several: nothing is written, and the chat asks.
 */
export const noteWork = (input: { text: string; ref?: string | null; onIt: boolean }) =>
  Effect.gen(function* () {
    const text = input.text.trim();
    // "i'm on pay-12" names PAY-12 too.
    const keys = [...new Set(text.toUpperCase().match(KEY_SCAN) ?? [])];
    const reached = new Map<string, ItemRow>();
    for (const k of keys) for (const i of yield* findItems(k)) reached.set(i.id, i);
    if (input.ref?.trim()) for (const i of yield* findItems(input.ref)) reached.set(i.id, i);
    // A ticket of a finished item and the active one: the active one is meant.
    const live = [...reached.values()];
    const active = live.filter((i) => i.status === "active");
    const options = active.length ? active : live;
    if (options.length !== 1 || !text) {
      const choices = (options.length ? options : yield* activeChoices).map((i) => ({
        id: i.id,
        name: i.name,
      }));
      return {
        status: "ask",
        reason: options.length > 1 ? "several" : "none",
        choices: choices.slice(0, 10),
      } satisfies NoteWorkResult;
    }
    const item = options[0] as ItemRow;
    yield* addNote(item.id, text);
    // Only an active item can be the one the user is on; a finished one keeps its history.
    const onIt = input.onIt && item.status === "active";
    if (onIt) yield* setCurrent(item.id);
    return {
      status: "noted",
      itemId: item.id,
      item: item.name,
      current: onIt || !!item.current,
    } satisfies NoteWorkResult;
  });

const activeChoices = query((d) =>
  d
    .select()
    .from(workItems)
    .where(eq(workItems.status, "active"))
    .orderBy(desc(workItems.current), workItems.name)
    .all(),
);

/** The item the user is on, for `my_focus` and the brief. */
export const currentItem = Effect.map(
  query((d) =>
    d
      .select()
      .from(workItems)
      .where(and(eq(workItems.current, true), eq(workItems.status, "active")))
      .get(),
  ),
  (item) => {
    if (!item) return null;
    const state = parseState(item.state);
    return {
      id: item.id,
      name: item.name,
      currentStep: state?.currentStep || null,
      nextExpected: state?.nextExpected ?? null,
    };
  },
);

// ---------------------------------------------------------------------------
// The brief and the report
// ---------------------------------------------------------------------------

export type BriefWork = {
  current: {
    name: string;
    currentStep: string | null;
    nextExpected: { what: string; on: string | null } | null;
  } | null;
  /** Items whose next expected date is today or past. */
  expected: { item: string; what: string; on: string }[];
  /** Open commitments due today or past; `to` is null for a promise to no one named. */
  commitments: { item: string; what: string; to: string | null; dueOn: string }[];
};

/** The work facts of the brief (D61 Reads): the current item, what is expected and what is owed. */
export const briefWork = (today: string) =>
  Effect.gen(function* () {
    const names = yield* contactNames;
    const items = yield* query((d) =>
      d.select().from(workItems).where(eq(workItems.status, "active")).all(),
    );
    const sorted = [...items].sort(
      (a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name),
    );
    let current: BriefWork["current"] = null;
    const expected: BriefWork["expected"] = [];
    const commitments: BriefWork["commitments"] = [];
    for (const item of sorted) {
      const state = parseState(item.state);
      if (item.current)
        current = {
          name: item.name,
          currentStep: state?.currentStep || null,
          nextExpected: state?.nextExpected ?? null,
        };
      const next = state?.nextExpected;
      if (next?.on && next.on <= today)
        expected.push({ item: item.name, what: next.what, on: next.on });
      for (const c of openCommitments(state))
        if (c.dueOn && c.dueOn <= today)
          commitments.push({
            item: item.name,
            what: c.what,
            to: (c.toPersonId && names.get(c.toPersonId)) || c.toName || null,
            dueOn: c.dueOn,
          });
    }
    expected.sort((a, b) => a.on.localeCompare(b.on));
    commitments.sort((a, b) => a.dueOn.localeCompare(b.dueOn));
    return { current, expected, commitments } satisfies BriefWork;
  });

/** Each ticket's work item (active or done), for the report's grouping. */
export const workOfTickets = (keys: readonly string[]) =>
  keys.length === 0
    ? Effect.succeed(new Map<string, { id: string; name: string; goal: string | null }>())
    : Effect.map(
        query((d) =>
          d
            .select({
              key: workItemIssues.issueKey,
              id: workItems.id,
              name: workItems.name,
              goal: workItems.goal,
            })
            .from(workItemIssues)
            .innerJoin(workItems, eq(workItems.id, workItemIssues.workItemId))
            .where(
              and(inArray(workItemIssues.issueKey, [...keys]), ne(workItems.status, "dismissed")),
            )
            .all(),
        ),
        (rows) =>
          new Map(
            rows.map((r) => [r.key, { id: r.id, name: r.name, goal: r.goal ?? null }] as const),
          ),
      );

/**
 * Triage against the current item (FR-19.8, D62). An item is current for the
 * local day the user said they are on it, or until they clear it or it closes.
 * While one is current, an Inbox thread whose message events attach (Phase 23)
 * to another item is "about" that item and can be parked; one attached to the
 * current item is "about what you're on" and sorts first.
 *
 * Parking is the user's click, never code's: it sets `inbox_items.status` to
 * `parked` with a reason and the day it returns at the latest, keeps every
 * proposal pending and undecided, and records a `parked` event on the
 * thread's items. The pass brings a parked thread back when the current item
 * changes or closes, or on the first pass of the next local day (`unparked`).
 * Local writes only, like pin and snooze (D17); nothing touches Jira.
 */
import { and, desc, eq, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import { Effect } from "effect";
import { inboxItems, workEvents, workItems } from "@/db/schema";
import { localDate } from "@/lib/dates";
import { query } from "@/services/db";
import { appendEvents } from "./events";

/** Statuses a thread can be parked from: it is open. */
const PARKABLE = ["new", "triaged"] as const;

/** How an event's attachment counts: settled by code, the model, the user or an answer. */
const ATTACHED = ["code", "model", "user", "answer"] as const;

/** The local day after `now`'s. */
export const nextLocalDay = (now: Date) =>
  localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));

export type CurrentItem = { id: string; name: string; currentOn: string | null };

/**
 * The item the user is on today: active, marked current, and set today (an
 * item marked before `current_on` existed counts until the pass stamps it).
 */
export const currentItem = (today = localDate()) =>
  Effect.map(
    query((d) =>
      d
        .select({ id: workItems.id, name: workItems.name, currentOn: workItems.currentOn })
        .from(workItems)
        .where(and(eq(workItems.current, true), eq(workItems.status, "active")))
        .get(),
    ),
    (r): CurrentItem | null => (r && (!r.currentOn || r.currentOn >= today) ? r : null),
  );

/**
 * The pass's first look at the current item: one set on an earlier day is no
 * longer current; one set before `current_on` existed is stamped today.
 */
export const settleCurrent = (today: string) =>
  Effect.gen(function* () {
    yield* query((d) =>
      d
        .update(workItems)
        .set({ current: false })
        .where(and(eq(workItems.current, true), lt(workItems.currentOn, today))),
    );
    yield* query((d) =>
      d
        .update(workItems)
        .set({ currentOn: today })
        .where(and(eq(workItems.current, true), sql`${workItems.currentOn} IS NULL`)),
    );
  });

/**
 * The items each thread is about: the items its message events attached to,
 * and a work item's own questions thread. `ids` limits the threads read.
 */
export const itemsOfThreads = (ids?: readonly string[]) =>
  Effect.gen(function* () {
    const out = new Map<string, Set<string>>();
    const add = (thread: string | null, item: string | null) => {
      if (!thread || !item) return;
      const set = out.get(thread) ?? new Set<string>();
      set.add(item);
      out.set(thread, set);
    };
    if (ids && ids.length === 0) return out;
    const thread = sql<string>`json_extract(${workEvents.data}, '$.inboxItemId')`;
    const events = yield* query((d) =>
      d
        .select({ thread, item: workEvents.workItemId })
        .from(workEvents)
        .where(
          and(
            eq(workEvents.kind, "message"),
            isNotNull(workEvents.workItemId),
            inArray(workEvents.attachedBy, [...ATTACHED]),
            ids ? inArray(thread, [...ids]) : undefined,
          ),
        )
        .all(),
    );
    for (const e of events) add(e.thread, e.item);
    const own = yield* query((d) =>
      d
        .select({ id: inboxItems.id, item: inboxItems.workItemId })
        .from(inboxItems)
        .where(
          and(
            isNotNull(inboxItems.workItemId),
            ne(inboxItems.source, "secretary"),
            ids ? inArray(inboxItems.id, [...ids]) : undefined,
          ),
        )
        .all(),
    );
    for (const r of own) add(r.id, r.item);
    return out;
  });

/** Where a thread stands against the current item. */
export type ThreadAbout =
  | { kind: "current"; itemId: string; name: string }
  | { kind: "other"; itemId: string; name: string; current: string };

/** Pure: a thread's items against the current item. */
export function aboutOf(
  items: ReadonlySet<string> | undefined,
  current: CurrentItem | null,
  names: ReadonlyMap<string, string>,
): ThreadAbout | null {
  if (!current || !items || items.size === 0) return null;
  if (items.has(current.id)) return { kind: "current", itemId: current.id, name: current.name };
  const [first] = [...items].sort((a, b) => (names.get(a) ?? "").localeCompare(names.get(b) ?? ""));
  if (!first) return null;
  return {
    kind: "other",
    itemId: first,
    name: names.get(first) ?? "other work",
    current: current.name,
  };
}

const namesOf = (ids: readonly string[]) =>
  ids.length
    ? Effect.map(
        query((d) =>
          d
            .select({ id: workItems.id, name: workItems.name })
            .from(workItems)
            .where(inArray(workItems.id, [...ids]))
            .all(),
        ),
        (rows) => new Map(rows.map((r) => [r.id, r.name])),
      )
    : Effect.succeed(new Map<string, string>());

/** Each listed thread against the current item, for the Inbox. */
export const threadsAbout = (ids: readonly string[], today = localDate()) =>
  Effect.gen(function* () {
    const out = new Map<string, ThreadAbout>();
    const current = yield* currentItem(today);
    if (!current || ids.length === 0) return out;
    const items = yield* itemsOfThreads(ids);
    const names = yield* namesOf([...new Set([...items.values()].flatMap((s) => [...s]))]);
    for (const [thread, set] of items) {
      const about = aboutOf(set, current, names);
      if (about) out.set(thread, about);
    }
    return out;
  });

/** One thread against the current item, and whether Park applies to it. */
export const threadAbout = (inboxItemId: string, today = localDate()) =>
  Effect.gen(function* () {
    const row = yield* query((d) =>
      d
        .select({ status: inboxItems.status, source: inboxItems.source })
        .from(inboxItems)
        .where(eq(inboxItems.id, inboxItemId))
        .get(),
    );
    const about = (yield* threadsAbout([inboxItemId], today)).get(inboxItemId) ?? null;
    return {
      about,
      canPark:
        !!row &&
        row.source !== "secretary" &&
        (PARKABLE as readonly string[]).includes(row.status) &&
        about?.kind === "other",
    };
  });

/**
 * Parks a thread (D62): only one about other work while an item is current.
 * Its proposals stay pending and undecided. Returns null when it cannot be
 * parked (no current item, about the current item, not open).
 */
export const parkThread = (inboxItemId: string, words?: string | null, now = new Date()) =>
  Effect.gen(function* () {
    const today = localDate(now);
    const current = yield* currentItem(today);
    if (!current) return null;
    const row = yield* query((d) =>
      d.select().from(inboxItems).where(eq(inboxItems.id, inboxItemId)).get(),
    );
    if (!row || row.source === "secretary") return null;
    if (!(PARKABLE as readonly string[]).includes(row.status)) return null;
    const items = [...((yield* itemsOfThreads([inboxItemId])).get(inboxItemId) ?? [])];
    if (items.length === 0 || items.includes(current.id)) return null;
    const reason = words?.trim().replace(/\s+/g, " ").slice(0, 200) || `on ${current.name}`;
    const until = nextLocalDay(now);
    yield* query((d) =>
      d
        .update(inboxItems)
        .set({ status: "parked", parkedReason: reason, parkedUntil: until })
        .where(eq(inboxItems.id, inboxItemId)),
    );
    yield* appendEvents(
      items.map((itemId) => ({
        kind: "parked" as const,
        at: now.toISOString(),
        actor: "me" as const,
        ref: inboxItemId,
        summary: `Parked "${(row.summary ?? row.rawText).slice(0, 80)}": ${reason}`,
        // The status it had, so it returns to it (a failed run stays `new`).
        data: { inboxItemId, currentItemId: current.id, reason, status: row.status } as never,
        workItemId: itemId,
        attachedBy: "user" as const,
        applied: true,
      })),
    );
    return { reason, until, currentItemId: current.id };
  });

/** Brings a parked thread back to the top of the Inbox, saying why; its reason stays. */
export const unparkThread = (
  inboxItemId: string,
  why: string,
  by: "me" | "secretary" = "me",
  now = new Date(),
) =>
  Effect.gen(function* () {
    const row = yield* query((d) =>
      d.select().from(inboxItems).where(eq(inboxItems.id, inboxItemId)).get(),
    );
    if (row?.status !== "parked") return false;
    const before = (yield* lastParked([inboxItemId])).get(inboxItemId)?.status;
    yield* query((d) =>
      d
        .update(inboxItems)
        .set({ status: before ?? (row.triage ? "triaged" : "new"), parkedUntil: null })
        .where(eq(inboxItems.id, inboxItemId)),
    );
    const items = [...((yield* itemsOfThreads([inboxItemId])).get(inboxItemId) ?? [])];
    yield* appendEvents(
      items.map((itemId) => ({
        kind: "unparked" as const,
        at: now.toISOString(),
        actor: by,
        ref: inboxItemId,
        summary: `Back from parking: "${(row.summary ?? row.rawText).slice(0, 80)}" (${why})`,
        data: { inboxItemId, why } as never,
        workItemId: itemId,
        attachedBy: by === "me" ? ("user" as const) : ("code" as const),
        applied: true,
      })),
    );
    return true;
  });

/**
 * Each parked thread's latest `parked` event: the item it was parked against
 * and the status it had before.
 */
const lastParked = (ids: readonly string[]) =>
  Effect.map(
    ids.length
      ? query((d) =>
          d
            .select({ ref: workEvents.ref, data: workEvents.data })
            .from(workEvents)
            .where(and(eq(workEvents.kind, "parked"), inArray(workEvents.ref, [...ids])))
            .orderBy(desc(workEvents.id))
            .all(),
        )
      : Effect.succeed([] as { ref: string | null; data: unknown }[]),
    (rows) => {
      const out = new Map<
        string,
        { currentItemId: string | null; status: "new" | "triaged" | null }
      >();
      for (const r of rows) {
        if (!r.ref || out.has(r.ref)) continue;
        const data = (r.data ?? {}) as { currentItemId?: unknown; status?: unknown };
        out.set(r.ref, {
          currentItemId: typeof data.currentItemId === "string" ? data.currentItemId : null,
          status: data.status === "new" || data.status === "triaged" ? data.status : null,
        });
      }
      return out;
    },
  );

/**
 * Why a parked thread comes back now, or null while it stays (pure): the day
 * it was parked for is over, or the item it was parked against is no longer
 * the current one (closed, cleared, or the user moved on). An item merged into
 * the current one is the same work.
 */
export function returnReason(opts: {
  parkedUntil: string | null;
  today: string;
  against: { id: string; name: string; status: string; mergedInto: string | null } | null;
  current: CurrentItem | null;
}): string | null {
  const { against, current } = opts;
  if (opts.parkedUntil && opts.parkedUntil <= opts.today) return "a new day";
  if (!against) return current ? `you are on "${current.name}"` : "nothing is current";
  if (current && (current.id === against.id || against.mergedInto === current.id)) return null;
  if (against.status === "done") return `"${against.name}" is done`;
  if (current) return `you moved on to "${current.name}"`;
  return `you are no longer on "${against.name}"`;
}

/**
 * The pass's step (D62): parked threads whose current item changed or closed,
 * or whose day is over, come back. Returns how many came back.
 */
export const returnParked = (now = new Date()) =>
  Effect.gen(function* () {
    const today = localDate(now);
    const parked = yield* query((d) =>
      d
        .select({ id: inboxItems.id, parkedUntil: inboxItems.parkedUntil })
        .from(inboxItems)
        .where(eq(inboxItems.status, "parked"))
        .all(),
    );
    if (parked.length === 0) return 0;
    const current = yield* currentItem(today);
    const parkedBy = yield* lastParked(parked.map((p) => p.id));
    const against = new Map(
      [...parkedBy].flatMap(([k, v]) => (v.currentItemId ? [[k, v.currentItemId] as const] : [])),
    );
    const itemIds = [...new Set(against.values())];
    const items = new Map(
      (itemIds.length
        ? yield* query((d) =>
            d
              .select({
                id: workItems.id,
                name: workItems.name,
                status: workItems.status,
                mergedInto: workItems.mergedInto,
              })
              .from(workItems)
              .where(inArray(workItems.id, itemIds))
              .all(),
          )
        : []
      ).map((r) => [r.id, r]),
    );
    let returned = 0;
    for (const p of parked) {
      const id = against.get(p.id);
      const why = returnReason({
        parkedUntil: p.parkedUntil,
        today,
        against: (id && items.get(id)) || null,
        current,
      });
      if (!why) continue;
      if (yield* unparkThread(p.id, why, "secretary", now)) returned++;
    }
    return returned;
  });

/**
 * The user took a parked thread up (D62, Q1): a reply, a re-triage, or the
 * last decision in it. It comes back with an `unparked` event saying so.
 */
export const takeUp = (inboxItemId: string, why: "replied" | "decided") =>
  unparkThread(inboxItemId, why, "me").pipe(Effect.asVoid);

/**
 * The day each of these threads last came back from parking (local date of its
 * latest `unparked` event): a returned thread leads the Inbox for that day only.
 */
export const returnedOn = (ids: readonly string[]) =>
  Effect.map(
    ids.length
      ? query((d) =>
          d
            .select({ ref: workEvents.ref, at: workEvents.at })
            .from(workEvents)
            .where(and(eq(workEvents.kind, "unparked"), inArray(workEvents.ref, [...ids])))
            .all(),
        )
      : Effect.succeed([] as { ref: string | null; at: string }[]),
    (rows) => {
      const out = new Map<string, string>();
      for (const r of rows) {
        if (!r.ref) continue;
        const day = localDate(new Date(r.at));
        if ((out.get(r.ref) ?? "") < day) out.set(r.ref, day);
      }
      return out;
    },
  );

/** A thread that came back from parking (its reason kept, no return day left). */
export const isReturned = (r: {
  status: string;
  parkedReason: string | null;
  parkedUntil: string | null;
}) => r.status !== "parked" && !!r.parkedReason && !r.parkedUntil;

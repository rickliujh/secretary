/**
 * Appending work events (FR-19.2, D61). The code paths that already exist call
 * these after their own write: Intake, Proposals (executed, failed, revoked),
 * the sync upsert, Comms, the dependency queries and the ticket view. Events
 * start unattached; the pass attaches them (`attach.ts`). Recording never fails
 * the write that caused it: a failure is logged and the write stands.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import { monotonicFactory } from "ulidx";
import { people, workEvents, workItemIssues } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { logger } from "@/lib/log";
import { query } from "@/services/db";
import type { Actor, EventData, EventKind, MessageData } from "./schema";

export type NewEvent = {
  kind: EventKind;
  /** When it happened; defaults to now. */
  at?: string;
  actor: Actor;
  issueKey?: string | null;
  ref?: string | null;
  summary: string;
  data?: EventData | MessageData;
  /** Set when the caller already knows the item (a correction, an answer). */
  workItemId?: string | null;
  attachedBy?: typeof workEvents.$inferInsert.attachedBy;
  /** True for events the state update never reads. */
  applied?: boolean;
};

/** Event ids sort in the order they were recorded, also within one millisecond. */
const nextId = monotonicFactory();

/** Most characters of text an event keeps (a comment, a quote). */
export const EVENT_TEXT_CHARS = 4000;

const rowOf = (e: NewEvent, now: string): typeof workEvents.$inferInsert => ({
  id: nextId(),
  workItemId: e.workItemId ?? null,
  kind: e.kind,
  at: e.at ?? now,
  actor: e.actor,
  issueKey: e.issueKey ?? null,
  ref: e.ref ?? null,
  summary: e.summary.slice(0, 500),
  data: e.data ?? null,
  attachedBy: e.attachedBy ?? null,
  applied: e.applied ?? false,
  createdAt: now,
});

/** Appends events in one statement. Fails like any query; most callers use `recordEvents`. */
export const appendEvents = (events: readonly NewEvent[]) =>
  Effect.gen(function* () {
    if (events.length === 0) return [] as string[];
    const now = nowIso();
    const rows = events.map((e) => rowOf(e, now));
    for (let i = 0; i < rows.length; i += 200)
      yield* query((d) => d.insert(workEvents).values(rows.slice(i, i + 200)));
    return rows.map((r) => r.id);
  });

/** Appends events; a failure is logged and never fails the caller's write. */
export const recordEvents = (events: readonly NewEvent[]) =>
  appendEvents(events).pipe(
    Effect.asVoid,
    Effect.catchAll((e) => Effect.sync(() => logger.warn("Recording work events failed", e))),
  );

export const recordEvent = (e: NewEvent) => recordEvents([e]);

/**
 * Who a Jira user is to the secretary: the user, a contact (by Jira id), or a
 * Jira user that is no contact. Null and unknown users are the sync.
 */
export const jiraActor = (
  user: string | null | undefined,
  me: string | null,
  contacts: ReadonlyMap<string, string>,
): Actor => {
  if (!user) return "sync";
  if (me && user === me) return "me";
  const id = contacts.get(user.toLowerCase());
  return id ? `contact:${id}` : `jira:${user}`;
};

/** Contacts by lower-case Jira id, for `jiraActor`. */
export const contactsByJiraId = Effect.map(
  query((d) => d.select({ id: people.id, jira: people.jiraUsername }).from(people).all()),
  (rows) => new Map(rows.flatMap((r) => (r.jira ? [[r.jira.toLowerCase(), r.id] as const] : []))),
);

/** The item a ticket belongs to, if any. */
export const itemOfIssue = (issueKey: string) =>
  Effect.map(
    query((d) =>
      d
        .select({ id: workItemIssues.workItemId })
        .from(workItemIssues)
        .where(eq(workItemIssues.issueKey, issueKey))
        .get(),
    ),
    (r) => r?.id ?? null,
  );

/** A ticket opened again within this long records no second view. */
const VIEW_GAP_MS = 30 * 60 * 1000;

/**
 * The ticket view opened a ticket (D61): recorded on the timeline, never folded
 * into the state and never a reason for a state update.
 */
export const recordView = (issueKey: string, now = new Date()) =>
  Effect.gen(function* () {
    const last = yield* query((d) =>
      d
        .select({ at: workEvents.at })
        .from(workEvents)
        .where(and(eq(workEvents.kind, "ticket_viewed"), eq(workEvents.issueKey, issueKey)))
        .orderBy(desc(workEvents.at))
        .limit(1)
        .get(),
    );
    if (last && now.getTime() - Date.parse(last.at) < VIEW_GAP_MS) return;
    const item = yield* itemOfIssue(issueKey);
    yield* appendEvents([
      {
        kind: "ticket_viewed",
        at: now.toISOString(),
        actor: "me",
        issueKey,
        summary: `Opened ${issueKey}`,
        workItemId: item,
        attachedBy: item ? "code" : "none",
        applied: true,
      },
    ]);
  }).pipe(Effect.catchAll((e) => Effect.sync(() => logger.warn("Recording a view failed", e))));

/** Events of these items, newest first (the timeline). */
export const eventsOfItems = (itemIds: readonly string[], limit = 200) =>
  itemIds.length === 0
    ? Effect.succeed([] as (typeof workEvents.$inferSelect)[])
    : query((d) =>
        d
          .select()
          .from(workEvents)
          .where(inArray(workEvents.workItemId, [...itemIds]))
          .orderBy(desc(workEvents.at), desc(workEvents.id))
          .limit(limit)
          .all(),
      );

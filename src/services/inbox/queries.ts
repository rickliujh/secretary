/** Read models for the Inbox page. */
import { and, asc, desc, eq, isNotNull, isNull, like, ne, or, type SQL, sql } from "drizzle-orm";
import { Effect } from "effect";
import { bundles, inboxItems, inboxMessages, intakeItems, people, proposals } from "@/db/schema";
import { localDate } from "@/lib/dates";
import { query } from "@/services/db";
import {
  AssistantContentSchema,
  type MessagePart,
  UserContentSchema,
} from "@/services/intake/thread";
import { localRevokeBlock } from "@/services/proposals/revoke";
import { localRevokeData } from "@/services/proposals/revoke-facts";
import { type ProposalPayload, parsePayload } from "@/services/proposals/schema";
import {
  type DayEndQuestion,
  type DayEndRecord,
  dayEndOf,
  dayEndQuestions,
} from "@/services/work/dayend-query";
import { isReturned, returnedOn, type ThreadAbout, threadsAbout } from "@/services/work/park";
import { bundleRecordOf, type SituationRecord } from "@/services/work/schema";

export type InboxListItem = {
  id: string;
  source: string;
  senderName: string | null;
  summary: string | null;
  status: string;
  receivedAt: string;
  preview: string;
  pending: number;
  failed: number;
  error: string | null;
  /** Why the user parked it (D62); kept after it came back. */
  parkedReason: string | null;
  /** The day a parked thread returns at the latest. */
  parkedUntil: string | null;
  /** It came back from parking and still has something to decide: at the top. */
  returned: boolean;
  /** Against the current item, while one is current (D62). */
  about: ThreadAbout | null;
};

/**
 * The Inbox's threads (D22), newest first, at most `limit` of them, plus every
 * parked thread (the Parked section, which no limit may hide) and, while the
 * Inbox triages against the current item, every thread that came back from
 * parking today and still holds a pending proposal. With `against` on they are
 * ordered by `sortInbox`; off, by date with the parked ones last (D62).
 */
export const listInbox = (
  search = "",
  opts: {
    limit?: number;
    today?: string;
    /** Mark and order threads against the current item (Settings > Secretary, `parkInput`). */
    against?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const { limit = 100, today = localDate(), against = true } = opts;
    const term = search.trim();
    const pendingSql = sql<number>`(SELECT count(*) FROM ${proposals} p WHERE p.inbox_item_id = ${inboxItems.id} AND p.status = 'pending')`;
    const matches = term
      ? or(like(inboxItems.rawText, `%${term}%`), like(inboxItems.summary, `%${term}%`))
      : undefined;
    const select = (where: SQL | undefined, max?: number) =>
      query((d) => {
        const q = d
          .select({
            id: inboxItems.id,
            source: inboxItems.source,
            senderName: people.displayName,
            summary: inboxItems.summary,
            status: inboxItems.status,
            receivedAt: inboxItems.receivedAt,
            rawText: inboxItems.rawText,
            triage: inboxItems.triage,
            parkedReason: inboxItems.parkedReason,
            parkedUntil: inboxItems.parkedUntil,
            pending: pendingSql,
            failed: sql<number>`(SELECT count(*) FROM ${proposals} p WHERE p.inbox_item_id = ${inboxItems.id} AND p.status = 'failed')`,
          })
          .from(inboxItems)
          .leftJoin(people, eq(people.id, inboxItems.senderPersonId))
          .where(and(matches, where))
          .orderBy(desc(inboxItems.receivedAt));
        return max === undefined ? q.all() : q.limit(max).all();
      });
    const page = yield* select(ne(inboxItems.status, "parked"), limit);
    const parked = yield* select(eq(inboxItems.status, "parked"));
    // Back from parking with something to decide, wherever it falls by date.
    const back = against
      ? (yield* select(
          and(
            ne(inboxItems.status, "parked"),
            isNotNull(inboxItems.parkedReason),
            isNull(inboxItems.parkedUntil),
            sql`${pendingSql} > 0`,
          ),
        )).filter((r) => !page.some((x) => x.id === r.id))
      : [];
    const rows = [...page, ...back, ...parked];
    const ids = rows.map((r) => r.id);
    const about = against ? yield* threadsAbout(ids, today) : new Map<string, ThreadAbout>();
    // A returned thread leads for the day it came back only.
    const backOn = against
      ? yield* returnedOn(rows.filter((r) => isReturned(r)).map((r) => r.id))
      : new Map<string, string>();
    const items = rows.map(
      (r): InboxListItem => ({
        id: r.id,
        source: r.source,
        senderName: r.senderName,
        summary: r.summary,
        status: r.status,
        receivedAt: r.receivedAt,
        preview: r.rawText.replace(/\s+/g, " ").slice(0, 140),
        pending: Number(r.pending),
        failed: Number(r.failed),
        error: (r.triage as { error?: string } | null)?.error ?? null,
        parkedReason: r.parkedReason,
        parkedUntil: r.parkedUntil,
        returned: isReturned(r) && Number(r.pending) > 0 && backOn.get(r.id) === today,
        about: r.source === "secretary" ? null : (about.get(r.id) ?? null),
      }),
    );
    if (against) return sortInbox(items);
    // Date order; the parked ones (already last) for the Parked section.
    return items;
  });

/**
 * The Inbox order (D62), pure: threads back from parking first, then those
 * about the current item, then the rest as they came; parked threads last.
 */
export function sortInbox<T extends Pick<InboxListItem, "status" | "returned" | "about">>(
  items: readonly T[],
): T[] {
  const rank = (i: T) =>
    i.status === "parked" ? 3 : i.returned ? 0 : i.about?.kind === "current" ? 1 : 2;
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index)
    .map((x) => x.item);
}

export type ProposalView = Omit<typeof proposals.$inferSelect, "payload" | "editedPayload"> & {
  payload: ProposalPayload;
  editedPayload: ProposalPayload | null;
  /** Why it cannot be revoked, from local data (FR-14.5); null when Revoke may be offered. */
  revokeBlocked: string | null;
};

/** One message of a thread (D22), with its content parsed. */
export type ThreadMessage =
  | {
      id: string;
      role: "user";
      createdAt: string;
      parts: MessagePart[];
      /** Parts laid out in order as written, pastes inside lines (D56). */
      inline: boolean;
      source: string | null;
      answers: string | null;
      /** Set when a feature started the thread; such threads take no replies. */
      origin: "planner" | "rules" | null;
    }
  | { id: string; role: "assistant"; createdAt: string; summary: string | null };

const toMessage = (m: typeof inboxMessages.$inferSelect): ThreadMessage => {
  if (m.role === "user") {
    const c = UserContentSchema.safeParse(m.content);
    return {
      id: m.id,
      role: "user",
      createdAt: m.createdAt,
      parts: c.success ? c.data.parts : [],
      inline: c.success ? !!c.data.inline : false,
      source: c.success ? (c.data.source ?? null) : null,
      answers: c.success ? (c.data.answers ?? null) : null,
      origin: c.success ? (c.data.origin ?? null) : null,
    };
  }
  const c = AssistantContentSchema.safeParse(m.content);
  return {
    id: m.id,
    role: "assistant",
    createdAt: m.createdAt,
    summary: c.success ? c.data.summary : null,
  };
};

export const inboxDetail = (id: string) =>
  Effect.gen(function* () {
    const item = yield* query((d) =>
      d
        .select({
          id: inboxItems.id,
          source: inboxItems.source,
          senderPersonId: inboxItems.senderPersonId,
          senderName: people.displayName,
          rawText: inboxItems.rawText,
          receivedAt: inboxItems.receivedAt,
          status: inboxItems.status,
          summary: inboxItems.summary,
          triage: inboxItems.triage,
          workItemId: inboxItems.workItemId,
          parkedReason: inboxItems.parkedReason,
          parkedUntil: inboxItems.parkedUntil,
        })
        .from(inboxItems)
        .leftJoin(people, eq(people.id, inboxItems.senderPersonId))
        .where(eq(inboxItems.id, id))
        .get(),
    );
    if (!item) return null;
    const items = yield* query((d) =>
      d
        .select({
          id: intakeItems.id,
          idx: intakeItems.idx,
          quote: intakeItems.quote,
          summary: intakeItems.summary,
          tier: intakeItems.tier,
          model: intakeItems.model,
          escalated: intakeItems.escalated,
          lowConfidence: intakeItems.lowConfidence,
          error: intakeItems.error,
        })
        .from(intakeItems)
        .where(eq(intakeItems.inboxItemId, id))
        .orderBy(asc(intakeItems.idx))
        .all(),
    );
    const rows = yield* query((d) =>
      d
        .select()
        .from(proposals)
        .where(eq(proposals.inboxItemId, id))
        .orderBy(asc(proposals.seq))
        .all(),
    );
    const local = yield* localRevokeData(rows);
    const props = rows.map(
      (p): ProposalView => ({
        ...p,
        payload: parsePayload(p.payload),
        editedPayload: p.editedPayload ? parsePayload(p.editedPayload) : null,
        revokeBlocked: p.status === "executed" ? localRevokeBlock(p, local) : null,
      }),
    );
    const messages = yield* query((d) =>
      d
        .select()
        .from(inboxMessages)
        .where(eq(inboxMessages.inboxItemId, id))
        .orderBy(asc(inboxMessages.seq))
        .all(),
    );
    // The thread's playbook bundles (Phase 26), each shown as one card.
    const stored = yield* query((d) =>
      d.select().from(bundles).where(eq(bundles.inboxItemId, id)).all(),
    );
    const records: Record<string, SituationRecord> = {};
    for (const b of stored) {
      const r = bundleRecordOf(b.record);
      if (r) records[b.id] = r;
    }
    // The day's end-of-day page (D63): its questions live in their work threads.
    const record = item.source === "secretary" ? dayEndOf(item.triage) : null;
    const dayEnd: { record: DayEndRecord; questions: DayEndQuestion[] } | null = record
      ? { record, questions: yield* dayEndQuestions(record.questionIds) }
      : null;
    return {
      item: { ...item, error: (item.triage as { error?: string } | null)?.error ?? null },
      items,
      proposals: props,
      messages: messages.map(toMessage),
      bundles: records,
      dayEnd,
    };
  });

export type InboxDetail = NonNullable<Effect.Effect.Success<ReturnType<typeof inboxDetail>>>;

/** Pending proposals for the Inbox badge; a parked thread's wait until it is back (D62). */
export const pendingCount = query((d) =>
  d
    .select({ n: sql<number>`count(*)` })
    .from(proposals)
    .where(
      and(
        eq(proposals.status, "pending"),
        sql`NOT EXISTS (SELECT 1 FROM ${inboxItems} i WHERE i.id = ${proposals.inboxItemId} AND i.status = 'parked')`,
      ),
    )
    .get(),
).pipe(Effect.map((r) => Number(r?.n ?? 0)));

/** Read models for the Inbox page. */
import { asc, desc, eq, like, or, sql } from "drizzle-orm";
import { Effect } from "effect";
import { inboxItems, inboxMessages, intakeItems, people, proposals } from "@/db/schema";
import { query } from "@/services/db";
import {
  AssistantContentSchema,
  type MessagePart,
  UserContentSchema,
} from "@/services/intake/thread";
import type { ProposalPayload } from "@/services/proposals/schema";

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
};

export const listInbox = (search = "", limit = 100) =>
  Effect.gen(function* () {
    const term = search.trim();
    const rows = yield* query((d) =>
      d
        .select({
          id: inboxItems.id,
          source: inboxItems.source,
          senderName: people.displayName,
          summary: inboxItems.summary,
          status: inboxItems.status,
          receivedAt: inboxItems.receivedAt,
          rawText: inboxItems.rawText,
          triage: inboxItems.triage,
          pending: sql<number>`(SELECT count(*) FROM ${proposals} p WHERE p.inbox_item_id = ${inboxItems.id} AND p.status = 'pending')`,
          failed: sql<number>`(SELECT count(*) FROM ${proposals} p WHERE p.inbox_item_id = ${inboxItems.id} AND p.status = 'failed')`,
        })
        .from(inboxItems)
        .leftJoin(people, eq(people.id, inboxItems.senderPersonId))
        .where(
          term
            ? or(like(inboxItems.rawText, `%${term}%`), like(inboxItems.summary, `%${term}%`))
            : undefined,
        )
        .orderBy(desc(inboxItems.receivedAt))
        .limit(limit)
        .all(),
    );
    return rows.map(
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
      }),
    );
  });

export type ProposalView = Omit<typeof proposals.$inferSelect, "payload" | "editedPayload"> & {
  payload: ProposalPayload;
  editedPayload: ProposalPayload | null;
};

/** One message of a thread (D22), with its content parsed. */
export type ThreadMessage =
  | {
      id: string;
      role: "user";
      createdAt: string;
      parts: MessagePart[];
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
    const props = (yield* query((d) =>
      d
        .select()
        .from(proposals)
        .where(eq(proposals.inboxItemId, id))
        .orderBy(asc(proposals.seq))
        .all(),
    )) as ProposalView[];
    const messages = yield* query((d) =>
      d
        .select()
        .from(inboxMessages)
        .where(eq(inboxMessages.inboxItemId, id))
        .orderBy(asc(inboxMessages.seq))
        .all(),
    );
    return {
      item: { ...item, error: (item.triage as { error?: string } | null)?.error ?? null },
      items,
      proposals: props,
      messages: messages.map(toMessage),
    };
  });

export type InboxDetail = NonNullable<Effect.Effect.Success<ReturnType<typeof inboxDetail>>>;

export const pendingCount = query((d) =>
  d
    .select({ n: sql<number>`count(*)` })
    .from(proposals)
    .where(eq(proposals.status, "pending"))
    .get(),
).pipe(Effect.map((r) => Number(r?.n ?? 0)));

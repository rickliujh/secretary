/** The daily note's rows (D65): a day's note and what the secretary read of it. */
import { and, asc, desc, eq, gte, inArray } from "drizzle-orm";
import { Effect } from "effect";
import { z } from "zod";
import {
  dailyNoteBlocks,
  dailyNotes,
  inboxItems,
  inboxMessages,
  jiraIssues,
  proposals,
} from "@/db/schema";
import { localDate } from "@/lib/dates";
import { newId, nowIso } from "@/lib/ids";
import { readJson } from "@/lib/json";
import { query } from "@/services/db";
import { UserContentSchema } from "@/services/intake/thread";
import { effectivePayload, issueRefs } from "@/services/proposals/schema";
import { getState, setState } from "@/services/sync/state";
import type { ReadResult } from ".";
import { type NoteBlock, uncheckedHashOf } from "./blocks";

export type NoteRow = typeof dailyNotes.$inferSelect;
export type BlockRow = typeof dailyNoteBlocks.$inferSelect;
export type BlockStatus = BlockRow["status"];

/** The day before a local YYYY-MM-DD date. */
export function dayBefore(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const prev = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) - 1));
  return prev.toISOString().slice(0, 10);
}

/** The local day `days` before a YYYY-MM-DD date. */
export function daysBefore(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) - days)).toISOString().slice(0, 10);
}

/**
 * Local midnight of a YYYY-MM-DD date, `days` earlier (negative: later), as an
 * ISO timestamp to compare with stored timestamps.
 */
export function localMidnightIso(date: string, days = 0): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, (d ?? 1) - days).toISOString();
}

/** How far back the reading looks for blocks and threads the note made (D66). */
export const RECENT_DAYS = 14;

export const loadRow = (date: string) =>
  query((d) => d.select().from(dailyNotes).where(eq(dailyNotes.date, date)).get());

/** Saves the body as typed; the merge base and sync time stay. */
export const saveBody = (date: string, body: string) =>
  Effect.gen(function* () {
    const now = nowIso();
    yield* query((d) =>
      d
        .insert(dailyNotes)
        .values({ date, body, updatedAt: now })
        .onConflictDoUpdate({ target: dailyNotes.date, set: { body, updatedAt: now } }),
    );
    return now;
  });

/** Records a sync: the merged text is both the body and the new base. */
export const saveSynced = (date: string, text: string, vaultSourceId: string) =>
  Effect.gen(function* () {
    const now = nowIso();
    const row = yield* loadRow(date);
    const set = {
      body: text,
      base: text,
      syncedAt: now,
      vaultSourceId,
      updatedAt: row && row.body === text ? row.updatedAt : now,
    };
    yield* query((d) =>
      d
        .insert(dailyNotes)
        .values({ date, ...set, updatedAt: set.updatedAt })
        .onConflictDoUpdate({ target: dailyNotes.date, set }),
    );
    return now;
  });

export const blockRows = (dates: readonly string[]) =>
  query((d) => d.select().from(dailyNoteBlocks).where(inArray(dailyNoteBlocks.date, dates)).all());

/**
 * The blocks read in the `days` before `today` and on it that led somewhere or
 * were left alone (acted, context, skipped), by hash; the newest row of a hash
 * wins (D66: a block carried over to another day is the same block). `ticked`:
 * the unticked hash of each ticked box recorded as acted (a close was
 * proposed), with when the newest was seen.
 */
export const recentBlocks = (today: string, days = RECENT_DAYS) =>
  Effect.map(
    query((d) =>
      d
        .select()
        .from(dailyNoteBlocks)
        .where(
          and(
            gte(dailyNoteBlocks.date, daysBefore(today, days)),
            inArray(dailyNoteBlocks.status, ["acted", "context", "skipped"]),
          ),
        )
        .orderBy(asc(dailyNoteBlocks.date), asc(dailyNoteBlocks.seenAt))
        .all(),
    ),
    (rows) => {
      const byHash = new Map<string, BlockRow>();
      const ticked = new Map<string, string>();
      for (const r of rows) {
        byHash.set(r.hash, r);
        const unticked = r.status === "acted" ? uncheckedHashOf(r.text) : null;
        if (unticked) ticked.set(unticked, r.seenAt);
      }
      return { byHash, ticked };
    },
  );

/**
 * Whether every ticket a thread's executed creates made is done in the cache
 * (D66): a to-do whose ticket is closed may come back as a new one. False when
 * the thread made none, or one is not cached.
 */
export const createdAllDone = (inboxItemId: string) =>
  Effect.gen(function* () {
    const rows = yield* query((d) =>
      d
        .select({ result: proposals.result })
        .from(proposals)
        .where(
          and(
            eq(proposals.inboxItemId, inboxItemId),
            eq(proposals.kind, "create_issue"),
            eq(proposals.status, "executed"),
          ),
        )
        .all(),
    );
    const keys = [
      ...new Set(
        rows
          .map((r) => (r.result as { issueKey?: string } | null)?.issueKey)
          .filter((k): k is string => !!k),
      ),
    ];
    if (!keys.length) return false;
    const cached = yield* query((d) =>
      d
        .select({ key: jiraIssues.key, category: jiraIssues.statusCategory })
        .from(jiraIssues)
        .where(inArray(jiraIssues.key, keys))
        .all(),
    );
    return keys.every((k) => cached.find((c) => c.key === k)?.category === "done");
  });

/** How many of the note's threads the triage call is shown (design.md 7.2). */
export const NOTE_THREADS_LISTED = 10;

/** A thread the note started (D66), as the reading routes blocks to it. */
export type NoteThread = {
  id: string;
  /** The day it started: its first message's note day, else when it arrived. */
  date: string;
  summary: string;
  /** Tickets its executed creates made. */
  created: string[];
  /** Tickets its other proposals that are not rejected or replaced act on. */
  acted: string[];
};

/**
 * The note's threads received since local midnight `days` before `today`,
 * newest first, each with its summary, the tickets it created and the tickets
 * it acts on. All of them: a named ticket may belong to an older one; the
 * triage call is shown the newest `NOTE_THREADS_LISTED`.
 */
export const recentNoteThreads = (today: string, days = RECENT_DAYS) =>
  Effect.gen(function* () {
    const items = yield* query((d) =>
      d
        .select()
        .from(inboxItems)
        .where(
          and(
            eq(inboxItems.source, "note"),
            gte(inboxItems.receivedAt, localMidnightIso(today, days)),
          ),
        )
        .orderBy(desc(inboxItems.receivedAt))
        .all(),
    );
    if (!items.length) return [] as NoteThread[];
    const ids = items.map((i) => i.id);
    const rows = yield* query((d) =>
      d.select().from(proposals).where(inArray(proposals.inboxItemId, ids)).all(),
    );
    const firsts = yield* query((d) =>
      d
        .select()
        .from(inboxMessages)
        .where(and(inArray(inboxMessages.inboxItemId, ids), eq(inboxMessages.seq, 0)))
        .all(),
    );
    return items.map((item): NoteThread => {
      const own = rows.filter((r) => r.inboxItemId === item.id);
      const created = own
        .filter((r) => r.kind === "create_issue" && r.status === "executed")
        .map((r) => (r.result as { issueKey?: string } | null)?.issueKey)
        .filter((k): k is string => !!k);
      const acted = own
        .filter((r) => !["rejected", "superseded"].includes(r.status))
        .flatMap((r) => issueRefs(effectivePayload(r), { only: "keys" }));
      const first = firsts.find((m) => m.inboxItemId === item.id);
      const noteDate = UserContentSchema.safeParse(first?.content).data?.noteDate;
      return {
        id: item.id,
        date: noteDate ?? localDate(new Date(item.receivedAt)),
        summary: item.summary ?? "(not read yet)",
        created: [...new Set(created)],
        acted: [...new Set(acted)].filter((k) => !created.includes(k)),
      };
    });
  });

/** Records a block as read; the same words on the same day are one row. */
export const recordBlock = (
  date: string,
  block: Pick<NoteBlock, "hash" | "text" | "section" | "position">,
  status: BlockStatus,
  refs: { inboxItemId?: string | null; workItemId?: string | null } = {},
) =>
  Effect.gen(function* () {
    const now = nowIso();
    const handledAt = status === "private" ? null : now;
    yield* query((d) =>
      d
        .insert(dailyNoteBlocks)
        .values({
          id: newId(),
          date,
          hash: block.hash,
          text: block.text,
          section: block.section,
          position: block.position,
          status,
          inboxItemId: refs.inboxItemId ?? null,
          workItemId: refs.workItemId ?? null,
          seenAt: now,
          handledAt,
        })
        .onConflictDoUpdate({
          target: [dailyNoteBlocks.date, dailyNoteBlocks.hash],
          set: {
            status,
            text: block.text,
            position: block.position,
            inboxItemId: refs.inboxItemId ?? null,
            workItemId: refs.workItemId ?? null,
            handledAt,
          },
        }),
    );
  });

export const setBlockStatus = (id: string, status: BlockStatus) =>
  query((d) =>
    d
      .update(dailyNoteBlocks)
      .set({ status, handledAt: nowIso() })
      .where(eq(dailyNoteBlocks.id, id)),
  );

const LAST_READ = "note.lastRead";

const ReadResultSchema = z.object({
  at: z.string(),
  trigger: z.enum(["pass", "typing", "button", "chat"]),
  skipped: z.literal("disabled").optional(),
  cards: z.number(),
  revised: z.number(),
  closed: z.number(),
  notes: z.array(z.string()),
  skippedBlocks: z.number(),
  privateBlocks: z.number(),
  left: z.number(),
  /** Absent in results stored before Phase 30. */
  continued: z.number().default(0),
  called: z.boolean(),
  error: z.string().nullable(),
});

export const saveLastRead = (r: ReadResult) => setState(LAST_READ, JSON.stringify(r));

export const loadLastRead = Effect.map(
  getState(LAST_READ),
  (v) => readJson(v, ReadResultSchema.nullable(), null) as ReadResult | null,
);

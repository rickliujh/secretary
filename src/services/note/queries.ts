/** The daily note's rows (D65): a day's note and what the secretary read of it. */
import { eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import { z } from "zod";
import { dailyNoteBlocks, dailyNotes } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { readJson } from "@/lib/json";
import { query } from "@/services/db";
import { getState, setState } from "@/services/sync/state";
import type { ReadResult } from ".";
import type { NoteBlock } from "./blocks";

export type NoteRow = typeof dailyNotes.$inferSelect;
export type BlockRow = typeof dailyNoteBlocks.$inferSelect;
export type BlockStatus = BlockRow["status"];

/** The day before a local YYYY-MM-DD date. */
export function dayBefore(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const prev = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) - 1));
  return prev.toISOString().slice(0, 10);
}

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
  called: z.boolean(),
  error: z.string().nullable(),
});

export const saveLastRead = (r: ReadResult) => setState(LAST_READ, JSON.stringify(r));

export const loadLastRead = Effect.map(
  getState(LAST_READ),
  (v) => readJson(v, ReadResultSchema.nullable(), null) as ReadResult | null,
);

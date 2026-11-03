/**
 * The reading of the daily note (FR-20.3, FR-20.4, D65). Code does the work:
 * it splits today's and yesterday's note into blocks, compares their hashes
 * with what was read before, and decides in order:
 *
 * 1. A block read before is left alone (the same block is never sent twice).
 * 2. A block under the private heading is recorded `private` and never sent.
 * 3. A ticked box whose unticked line made a ticket that now exists proposes
 *    closing it (a card in the same thread); ticking anything else does
 *    nothing.
 * 4. A changed block (its old words gone, new words at its place) whose
 *    thread still has undecided proposals revises that thread through
 *    `Intake.reply` with "The note now says: «...»" (D56).
 * 5. Every other new block, at most 30, oldest first, goes to one
 *    `note_triage` call, which says per block act, context (one of the
 *    listed work items) or skip. Act: `Intake.triage` with source "note".
 *    Context: a `note` event on the item, as the user's words. Skip: recorded.
 *
 * No new blocks, no model call. Nothing here calls `JiraClient`; the close
 * is a proposal like any other.
 */
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { Effect, Either } from "effect";
import {
  inboxItems,
  inboxMessages,
  jiraIssues,
  proposals,
  workItemIssues,
  workItems,
} from "@/db/schema";
import { localDate } from "@/lib/dates";
import { newId, nowIso } from "@/lib/ids";
import { logger } from "@/lib/log";
import {
  buildNoteTriagePrompt,
  buildNoteTriageSchema,
  NOTE_TRIAGE_MAX_BLOCKS,
  type NoteTriageItem,
  type NoteTriageOutput,
  noteDecisions,
  validateNoteTriage,
} from "@/prompts/note-triage";
import { query } from "@/services/db";
import { Intake } from "@/services/intake";
import { noteParts } from "@/services/intake/thread";
import { isCancelStatus } from "@/services/jira/cancel";
import { Llm } from "@/services/llm";
import { effectivePayload } from "@/services/proposals/schema";
import { Settings, settingsOrDefault } from "@/services/settings";
import { addNote } from "@/services/work/queries";
import { parseState } from "@/services/work/schema";
import type { ReadResult, ReadTrigger } from ".";
import { type NoteBlock, similarity, splitBlocks } from "./blocks";
import {
  type BlockRow,
  blockRows,
  dayBefore,
  loadRow,
  recordBlock,
  saveLastRead,
  setBlockStatus,
} from "./queries";

/** Most active work items offered to `note_triage`. */
const MAX_ITEMS = 20;
/** A changed block is matched to the gone one at its place, or to one this alike. */
const CHANGED_SIMILARITY = 0.5;

const emptyResult = (trigger: ReadTrigger, at: string): ReadResult => ({
  at,
  trigger,
  cards: 0,
  revised: 0,
  closed: 0,
  notes: [],
  skippedBlocks: 0,
  privateBlocks: 0,
  left: 0,
  called: false,
  error: null,
});

/** The text a revision sends, on one line so it stays a value (D56). */
const oneLine = (text: string) => text.replace(/\s*\r?\n\s*/g, " / ").trim();

/** Active work items, the current one first, as `note_triage` candidates. */
const candidateItems = Effect.gen(function* () {
  const items = yield* query((d) =>
    d
      .select()
      .from(workItems)
      .where(eq(workItems.status, "active"))
      .orderBy(desc(workItems.current), desc(workItems.stateUpdatedAt), workItems.name)
      .limit(MAX_ITEMS)
      .all(),
  );
  if (!items.length) return [] as NoteTriageItem[];
  const links = yield* query((d) =>
    d
      .select()
      .from(workItemIssues)
      .where(
        inArray(
          workItemIssues.workItemId,
          items.map((i) => i.id),
        ),
      )
      .all(),
  );
  return items.map((i): NoteTriageItem => {
    const state = parseState(i.state);
    return {
      id: i.id,
      name: i.name,
      tickets: links.filter((l) => l.workItemId === i.id).map((l) => l.issueKey),
      now: state?.currentStep || null,
      current: i.current,
    };
  });
});

/** Whether a thread still holds a proposal no one decided. */
const hasPending = (inboxItemId: string) =>
  Effect.map(
    query((d) =>
      d
        .select({ n: sql<number>`count(*)` })
        .from(proposals)
        .where(and(eq(proposals.inboxItemId, inboxItemId), eq(proposals.status, "pending")))
        .get(),
    ),
    (r) => Number(r?.n ?? 0) > 0,
  );

/**
 * The status a ticket closes into, from the cache: the most used done-category
 * status of its project that is not a cancel-like one; "Done" when none is known.
 * The executor checks it against Jira's transitions when the user approves.
 */
const doneStatusOf = (key: string) =>
  Effect.gen(function* () {
    const project = key.split("-")[0] ?? "";
    const rows = yield* query((d) =>
      d
        .select({ status: jiraIssues.status, n: sql<number>`count(*)` })
        .from(jiraIssues)
        .where(and(eq(jiraIssues.projectKey, project), eq(jiraIssues.statusCategory, "done")))
        .groupBy(jiraIssues.status)
        .orderBy(desc(sql`count(*)`))
        .all(),
    );
    return rows.find((r) => !isCancelStatus(r.status))?.status ?? "Done";
  });

/**
 * A ticked box (FR-20.4): the tickets its unticked line created, and whether a
 * create is still waiting for a decision. Proposes closing the created ones.
 */
const closeTicked = (inboxItemId: string, block: NoteBlock) =>
  Effect.gen(function* () {
    // A thread the user dismissed stays dismissed: the tick does nothing.
    const thread = yield* query((d) =>
      d
        .select({ status: inboxItems.status })
        .from(inboxItems)
        .where(eq(inboxItems.id, inboxItemId))
        .get(),
    );
    if (!thread || thread.status === "dismissed") return "none" as const;
    const rows = yield* query((d) =>
      d
        .select()
        .from(proposals)
        .where(eq(proposals.inboxItemId, inboxItemId))
        .orderBy(proposals.seq)
        .all(),
    );
    const creates = rows.filter((r) => r.kind === "create_issue");
    const created = creates
      .filter((r) => r.status === "executed")
      .map((r) => (r.result as { issueKey?: string } | null)?.issueKey)
      .filter((k): k is string => !!k);
    if (!created.length) {
      const waiting = creates.some((r) => r.status === "pending" || r.status === "approved");
      return waiting ? ("wait" as const) : ("none" as const);
    }
    const closing = new Set(
      rows
        .filter((r) => r.kind === "transition_issue" && r.status !== "rejected")
        .map((r) => (effectivePayload(r) as { target?: string }).target),
    );
    const keys = created.filter((k) => !closing.has(k));
    if (!keys.length) return "closed" as const;
    const now = nowIso();
    const messageId = newId();
    const seq = yield* query((d) =>
      d
        .select({ n: sql<number>`max(${inboxMessages.seq})` })
        .from(inboxMessages)
        .where(eq(inboxMessages.inboxItemId, inboxItemId))
        .get(),
    );
    yield* query((d) =>
      d.insert(inboxMessages).values({
        id: messageId,
        inboxItemId,
        seq: Number(seq?.n ?? 0) + 1,
        role: "assistant",
        content: {
          summary: `Ticked in your note: close ${keys.join(", ")}`,
        },
        createdAt: now,
      }),
    );
    const maxSeq = Math.max(-1, ...rows.map((r) => r.seq));
    const values: (typeof proposals.$inferInsert)[] = [];
    for (const [i, key] of keys.entries())
      values.push({
        id: newId(),
        inboxItemId,
        messageId,
        seq: maxSeq + 1 + i,
        kind: "transition_issue",
        payload: { kind: "transition_issue", target: key, toStatus: yield* doneStatusOf(key) },
        rationale: "You ticked this line in your daily note.",
        evidence: block.text.slice(0, 300),
        confidence: 1,
        status: "pending" as const,
        createdAt: now,
      });
    yield* query((d) => d.insert(proposals).values(values));
    yield* query((d) =>
      d.update(inboxItems).set({ status: "triaged" }).where(eq(inboxItems.id, inboxItemId)),
    );
    return "closed" as const;
  });

/** The gone block a new one replaces: the one at its place, else the most alike. */
function changedFrom(block: NoteBlock, gone: readonly BlockRow[], used: Set<string>) {
  const open = gone.filter((g) => !used.has(g.id));
  const atPlace = open.find((g) => g.position === block.position);
  if (atPlace && similarity(atPlace.text, block.text) > 0) return atPlace;
  let best: BlockRow | null = null;
  let score = CHANGED_SIMILARITY;
  for (const g of open) {
    const s = similarity(g.text, block.text);
    if (s >= score) {
      best = g;
      score = s;
    }
  }
  return best;
}

/** The note thread a failed triage left behind, so the block is not sent again. */
const threadOf = (rawSince: string) =>
  Effect.map(
    query((d) =>
      d
        .select({ id: inboxItems.id })
        .from(inboxItems)
        .where(and(eq(inboxItems.source, "note"), gte(inboxItems.receivedAt, rawSince)))
        .orderBy(desc(inboxItems.receivedAt))
        .get(),
    ),
    (r) => r?.id ?? null,
  );

type Fresh = { date: string; block: NoteBlock };

export const readNote = (trigger: ReadTrigger, opts: { now?: Date } = {}) =>
  Effect.gen(function* () {
    const now = opts.now ?? new Date();
    const today = localDate(now);
    const settings = yield* settingsOrDefault(yield* Settings);
    const cfg = settings.secretary.dailyNote;
    const result = emptyResult(trigger, nowIso());
    if (!cfg.enabled) return { ...result, skipped: "disabled" } satisfies ReadResult;
    const intake = yield* Intake;
    const llm = yield* Llm;

    // Yesterday too, so lines written just before midnight are not lost.
    const dates = [dayBefore(today), today];
    const rows = yield* blockRows(dates);
    const fresh: Fresh[] = [];
    for (const date of dates) {
      const body = (yield* loadRow(date))?.body ?? "";
      const blocks = splitBlocks(body, cfg.privateHeading);
      const known = rows.filter((r) => r.date === date);
      const byHash = new Map(known.map((r) => [r.hash, r]));
      const present = new Set(blocks.map((b) => b.hash));
      const gone = known.filter(
        (r) => !present.has(r.hash) && r.status === "acted" && !!r.inboxItemId,
      );
      const used = new Set<string>();
      for (const block of blocks) {
        const seen = byHash.get(block.hash);
        // A block moved out of the private section is read like a new one.
        if (seen && !(seen.status === "private" && !block.private)) continue;
        if (block.private) {
          yield* recordBlock(date, block, "private");
          result.privateBlocks++;
          continue;
        }
        if (block.checked && block.uncheckedHash) {
          const was = byHash.get(block.uncheckedHash);
          if (was) {
            used.add(was.id);
            const outcome =
              was.status === "acted" && was.inboxItemId
                ? yield* closeTicked(was.inboxItemId, block)
                : ("none" as const);
            // A create still waiting for approval: ask again at the next reading.
            if (outcome === "wait") continue;
            if (outcome === "closed") {
              yield* recordBlock(date, block, "acted", { inboxItemId: was.inboxItemId });
              result.closed++;
            } else {
              yield* recordBlock(date, block, "skipped");
              result.skippedBlocks++;
            }
            continue;
          }
        }
        const old = changedFrom(block, gone, used);
        if (old?.inboxItemId && (yield* hasPending(old.inboxItemId))) {
          used.add(old.id);
          const inboxItemId = old.inboxItemId;
          const r = yield* Effect.either(
            intake.reply({
              inboxItemId,
              parts: [
                { type: "typed", text: "The note now says: " },
                { type: "pasted", text: oneLine(block.text) },
              ],
              today,
            }),
          );
          if (Either.isLeft(r)) logger.warn("Revising a note thread failed", r.left);
          yield* setBlockStatus(old.id, "revised");
          yield* recordBlock(date, block, "acted", { inboxItemId });
          result.revised++;
          continue;
        }
        fresh.push({ date, block });
      }
    }

    const batch = fresh.slice(0, NOTE_TRIAGE_MAX_BLOCKS);
    result.left = fresh.length - batch.length;
    if (!batch.length) {
      yield* saveLastRead(result);
      return result;
    }

    const items = settings.work.enabled ? yield* candidateItems : [];
    const ids = items.map((i) => i.id);
    result.called = true;
    const call = yield* Effect.either(
      llm.object<NoteTriageOutput>("note_triage", {
        schema: buildNoteTriageSchema(batch.length, ids) as never,
        ...buildNoteTriagePrompt({
          blocks: batch.map((f) => ({
            text: f.block.text,
            section: f.block.section,
            date: f.date,
          })),
          items,
          today,
        }),
        validate: (out) => validateNoteTriage(out, batch.length, ids),
      }),
    );
    if (Either.isLeft(call)) {
      // Nothing is recorded: the blocks are read again next time.
      result.error = call.left.message;
      yield* saveLastRead(result);
      return result;
    }
    const names = new Map(items.map((i) => [i.id, i.name]));
    for (const decision of noteDecisions(call.right.value, batch.length)) {
      const f = batch[decision.index];
      if (!f) continue;
      if (decision.kind === "act") {
        const since = nowIso();
        const r = yield* Effect.either(
          intake.triage({
            source: "note",
            parts: noteParts(f.block.text),
            senderPersonId: null,
            noteDate: f.date,
            today,
          }),
        );
        // A failed triage leaves its thread with the error and a retry; it is not sent again.
        const inboxItemId = Either.isRight(r) ? r.right.inboxItemId : yield* threadOf(since);
        if (Either.isLeft(r)) logger.warn("Reading a note block failed", r.left);
        yield* recordBlock(f.date, f.block, "acted", { inboxItemId });
        result.cards++;
      } else if (decision.kind === "context") {
        yield* addNote(decision.itemId, f.block.text);
        yield* recordBlock(f.date, f.block, "context", { workItemId: decision.itemId });
        result.notes.push(names.get(decision.itemId) ?? decision.itemId);
      } else {
        yield* recordBlock(f.date, f.block, "skipped");
        result.skippedBlocks++;
      }
    }
    yield* saveLastRead(result);
    if (result.cards || result.notes.length || result.revised || result.closed)
      logger.info(
        `Daily note read: ${result.cards} cards, ${result.notes.length} notes, ${result.revised} revised, ${result.closed} closed, ${result.skippedBlocks} left alone`,
      );
    return result;
  });

/** The line the page shows: "Read at 10:42: 1 card, 1 note on <item>, 2 left alone". */
export function describeRead(r: ReadResult, time: (iso: string) => string): string {
  if (r.skipped) return "Reading is off in Settings.";
  const parts: string[] = [];
  const n = (count: number, one: string, many = `${one}s`) =>
    `${count} ${count === 1 ? one : many}`;
  if (r.cards) parts.push(n(r.cards, "card"));
  if (r.revised) parts.push(`${n(r.revised, "thread")} revised`);
  if (r.closed) parts.push(`${n(r.closed, "close")} proposed`);
  const byItem = new Map<string, number>();
  for (const name of r.notes) byItem.set(name, (byItem.get(name) ?? 0) + 1);
  for (const [name, count] of byItem) parts.push(`${n(count, "note")} on ${name}`);
  if (r.skippedBlocks) parts.push(`${r.skippedBlocks} left alone`);
  if (r.privateBlocks) parts.push(`${r.privateBlocks} private`);
  if (r.left) parts.push(`${r.left} for the next read`);
  const head = `Read at ${time(r.at)}`;
  if (r.error) return `${head}: could not read the new blocks (${r.error}).`;
  return parts.length ? `${head}: ${parts.join(", ")}.` : `${head}: nothing new.`;
}

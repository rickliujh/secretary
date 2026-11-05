/**
 * The reading of the daily note (FR-20.3, FR-20.4, D65). Code does the work:
 * it splits today's and yesterday's note into blocks, compares their hashes
 * with what was read before, and decides in order:
 *
 * 1. A block read before is left alone (the same block is never sent twice).
 * 2. A block under the private heading is recorded `private` and never sent.
 * 3. Carried over (D66): a block whose words a block of the last 14 days had,
 *    on another day, takes that block's status, thread and work item and is
 *    not sent; an unticked to-do copied into today's note is the same ask.
 *    Not when it came back after it was done: its ticked box was recorded, or
 *    every ticket its thread created is done; then it is read as new.
 * 4. A ticked box whose unticked line made a ticket that now exists proposes
 *    closing it (a card in the same thread); ticking anything else does
 *    nothing.
 * 5. A changed block (its old words gone, new words at its place) revises
 *    that thread through `Intake.reply` with "The note now says: «...»"
 *    (D56), whatever its proposals' status (D66): a decided thread knows what
 *    it made and decided. With nothing pending, the block at its place must
 *    be as alike as any other match (word overlap at least one half); a
 *    thread whose first turn failed (no items) is not revised.
 * 6. Every other new block, at most 30, oldest first, goes to one
 *    `note_triage` call, which says per block act (with one of the listed
 *    earlier note threads, or none), context (one of the listed work items)
 *    or skip. Act on a block naming a ticket that a note thread of the last
 *    14 days created or acts on continues the newest such thread, whatever
 *    thread the model gave (D66); other act with a thread: a new message in
 *    it; act: `Intake.triage` with source "note". Context: a `note` event on
 *    the item, as the user's words. Skip: recorded.
 *
 * A block that goes to a model (5 and 6) has its images read first (D71,
 * `image-reads.ts`): each image link becomes quoted lines holding the
 * transcript, for the model only; the recorded text keeps the link. A block
 * whose images cannot be loaded or read now is not sent and not recorded, so
 * the next reading tries again; `waiting` counts it and the page says why.
 *
 * Continuing a thread is `Intake.reply` with `asInput`: the block is a new
 * item of the thread, which sees its earlier items, decisions and created
 * tickets. No new blocks, no model call. Nothing here calls `JiraClient`; the
 * close is a proposal like any other.
 */
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { Effect, Either } from "effect";
import {
  inboxItems,
  inboxMessages,
  intakeItems,
  jiraIssues,
  proposals,
  workItemIssues,
  workItems,
} from "@/db/schema";
import { localDate } from "@/lib/dates";
import { newId, nowIso } from "@/lib/ids";
import { logger } from "@/lib/log";
import { ISSUE_KEY_SCAN } from "@/prompts/classify";
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
import { imageVault, prepareBlock, readingBudget } from "./image-reads";
import {
  type BlockRow,
  blockRows,
  createdAllDone,
  dayBefore,
  loadRow,
  NOTE_THREADS_LISTED,
  type NoteThread,
  recentBlocks,
  recentNoteThreads,
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
  continued: 0,
  closed: 0,
  notes: [],
  skippedBlocks: 0,
  privateBlocks: 0,
  left: 0,
  waiting: 0,
  waitReason: null,
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

/** The newest note thread that created or acts on a ticket the block names (D66). */
export function namedThread(text: string, threads: readonly NoteThread[]): NoteThread | null {
  const keys = new Set(text.match(ISSUE_KEY_SCAN) ?? []);
  if (!keys.size) return null;
  return threads.find((t) => [...t.created, ...t.acted].some((k) => keys.has(k))) ?? null;
}

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

/** Whether a thread holds a proposal no one decided, and how many items it has. */
const threadShape = (inboxItemId: string) =>
  Effect.gen(function* () {
    const pending = yield* query((d) =>
      d
        .select({ n: sql<number>`count(*)` })
        .from(proposals)
        .where(and(eq(proposals.inboxItemId, inboxItemId), eq(proposals.status, "pending")))
        .get(),
    );
    const items = yield* query((d) =>
      d
        .select({ n: sql<number>`count(*)` })
        .from(intakeItems)
        .where(eq(intakeItems.inboxItemId, inboxItemId))
        .get(),
    );
    return { pending: Number(pending?.n ?? 0) > 0, items: Number(items?.n ?? 0) };
  });

/**
 * The gone block a new one replaces: the one at its place, else the most
 * alike. The one at its place needs only a shared word while its thread still
 * has undecided proposals (an edit before a decision); once all are decided it
 * must be as alike as any other match, so an unrelated line written in the
 * place of a done one is not pulled into its thread (D66).
 */
export function changedFrom(
  block: NoteBlock,
  gone: readonly BlockRow[],
  used: Set<string>,
  pending: (row: BlockRow) => boolean,
) {
  const open = gone.filter((g) => !used.has(g.id));
  const atPlace = open.find((g) => g.position === block.position);
  const placeScore = atPlace ? similarity(atPlace.text, block.text) : 0;
  if (atPlace && placeScore > 0 && (pending(atPlace) || placeScore >= CHANGED_SIMILARITY))
    return atPlace;
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

type NoteIntake = Intake["Type"];
type Placed = {
  date: string;
  block: NoteBlock;
  today: string;
  /** The block as the model reads it, its images quoted (D71); else its text. */
  modelText?: string;
};

/** What the model is sent for a placed block: its images as quotes (D71). */
const modelTextOf = (p: Placed) => p.modelText ?? p.block.text;

/**
 * A block that continues an earlier thread (D66): a new item of it
 * (`asInput`), recorded as acted. A failed turn records nothing, so the next
 * reading tries again; the caller gets the outcome.
 */
export const continueThread = (intake: NoteIntake, inboxItemId: string, p: Placed) =>
  Effect.gen(function* () {
    const r = yield* Effect.either(
      intake.reply({
        inboxItemId,
        asInput: true,
        parts: noteParts(modelTextOf(p)),
        noteDate: p.date,
        today: p.today,
      }),
    );
    if (Either.isRight(r)) yield* recordBlock(p.date, p.block, "acted", { inboxItemId });
    return r;
  });

/**
 * A changed block revises the thread of the block it replaces, decided or
 * not (D66): "The note now says: «...»" (D56). The old row becomes revised
 * and the new block acted. A failed turn records nothing.
 */
export const reviseThread = (
  intake: NoteIntake,
  old: { id: string; inboxItemId: string },
  p: Placed,
) =>
  Effect.gen(function* () {
    const r = yield* Effect.either(
      intake.reply({
        inboxItemId: old.inboxItemId,
        parts: [
          { type: "typed", text: "The note now says: " },
          { type: "pasted", text: oneLine(modelTextOf(p)) },
        ],
        today: p.today,
      }),
    );
    if (Either.isLeft(r)) return r;
    yield* setBlockStatus(old.id, "revised");
    yield* recordBlock(p.date, p.block, "acted", { inboxItemId: old.inboxItemId });
    return r;
  });

/**
 * A new conversation on a block: `Intake.triage` with source "note". A failed
 * triage leaves its thread with the error and a retry; the block is recorded
 * acted on it either way, so it is not sent again. With `orphan: false` (Ask)
 * a failure that left no thread records nothing, so the block stays as it was.
 */
export const startThread = (intake: NoteIntake, p: Placed, opts: { orphan?: boolean } = {}) =>
  Effect.gen(function* () {
    const since = nowIso();
    const r = yield* Effect.either(
      intake.triage({
        source: "note",
        parts: noteParts(modelTextOf(p)),
        senderPersonId: null,
        noteDate: p.date,
        today: p.today,
      }),
    );
    const inboxItemId = Either.isRight(r) ? r.right.inboxItemId : yield* threadOf(since);
    if (inboxItemId || opts.orphan !== false)
      yield* recordBlock(p.date, p.block, "acted", { inboxItemId });
    return { inboxItemId, error: Either.isLeft(r) ? r.left : null };
  });

/**
 * The blocks of a day a changed block may replace (D66): acted rows with a
 * thread whose words are gone from the note, without threads whose first turn
 * failed (nothing to revise), and whether each one's thread still waits for a
 * decision.
 */
export const replaceable = (known: readonly BlockRow[], present: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const goneRows = known.filter(
      (r) => !present.has(r.hash) && r.status === "acted" && !!r.inboxItemId,
    );
    const shapes = new Map<string, { pending: boolean; items: number }>();
    for (const g of goneRows)
      if (g.inboxItemId && !shapes.has(g.inboxItemId))
        shapes.set(g.inboxItemId, yield* threadShape(g.inboxItemId));
    const gone = goneRows.filter((g) => (shapes.get(g.inboxItemId ?? "")?.items ?? 0) > 0);
    const pendingIn = (g: BlockRow) => !!shapes.get(g.inboxItemId ?? "")?.pending;
    return { gone, pendingIn };
  });

/**
 * Whether a carried-over block came back after it was done (D66): its ticked
 * box was recorded since, or every ticket its thread created is done. Then it
 * is read as new.
 */
export const cameBackAfterDone = (ticked: ReadonlyMap<string, string>) => (earlier: BlockRow) =>
  Effect.gen(function* () {
    const tickedAt = ticked.get(earlier.hash);
    if (tickedAt && tickedAt >= earlier.seenAt) return true;
    if (earlier.status !== "acted" || !earlier.inboxItemId) return false;
    return yield* createdAllDone(earlier.inboxItemId);
  });

type Fresh = {
  date: string;
  block: NoteBlock;
  /** The note thread a ticket the block names belongs to (D66). */
  named?: string;
};

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
    // The note's images are read for the blocks that go to a model (D71).
    const vault = yield* imageVault;
    // A failed transcription is sent again only by Read now (or six hours on).
    const budget = readingBudget(trigger === "button");
    /** The block's texts for the models, or null when its images wait (counted). */
    const forModel = (block: NoteBlock) =>
      Effect.map(prepareBlock(vault, block.text, budget), (p) => {
        if (p.status === "ready") return { text: p.text, triageText: p.triageText };
        if (p.reason === "cap") result.left++;
        else {
          result.waiting++;
          result.waitReason ??= p.message;
        }
        return null;
      });

    // Yesterday too, so lines written just before midnight are not lost.
    const dates = [dayBefore(today), today];
    const rows = yield* blockRows(dates);
    // What the note led to in the last two weeks (D66).
    const { byHash: recent, ticked } = yield* recentBlocks(today);
    const threads = yield* recentNoteThreads(today);
    const cameBack = cameBackAfterDone(ticked);
    const fresh: Fresh[] = [];
    // The same new block on both days is read once; the copy follows it.
    const thisRead = new Set<string>();
    const twins: Fresh[] = [];
    for (const date of dates) {
      const body = (yield* loadRow(date))?.body ?? "";
      const blocks = splitBlocks(body, cfg.privateHeading);
      const known = rows.filter((r) => r.date === date);
      const byHash = new Map(known.map((r) => [r.hash, r]));
      const present = new Set(blocks.map((b) => b.hash));
      // A thread whose first turn failed has nothing to revise: the block is read as new.
      const { gone, pendingIn } = yield* replaceable(known, present);
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
        // Carried over from another day: the same block, nothing sent (D66).
        const earlier = recent.get(block.hash);
        if (earlier && earlier.date !== date && !(yield* cameBack(earlier))) {
          yield* recordBlock(date, block, earlier.status, {
            inboxItemId: earlier.inboxItemId,
            workItemId: earlier.workItemId,
          });
          continue;
        }
        if (thisRead.has(block.hash)) {
          twins.push({ date, block });
          continue;
        }
        thisRead.add(block.hash);
        if (block.checked && block.uncheckedHash) {
          // Its unticked line on this day, else carried from another day (D66).
          const before = recent.get(block.uncheckedHash);
          const was =
            byHash.get(block.uncheckedHash) ??
            (before && before.date !== date ? before : undefined);
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
        // A changed block revises its thread, decided or not (D66).
        const old = changedFrom(block, gone, used, pendingIn);
        if (old?.inboxItemId) {
          used.add(old.id);
          // Its images wait: nothing is recorded, the next reading revises (D71).
          const prepared = yield* forModel(block);
          if (prepared === null) continue;
          const modelText = prepared.text;
          const r = yield* reviseThread(
            intake,
            { id: old.id, inboxItemId: old.inboxItemId },
            { date, block, today, modelText },
          );
          // A failed turn records nothing: the next reading tries the revision again.
          if (Either.isLeft(r)) logger.warn("Revising a note thread failed", r.left);
          else result.revised++;
          continue;
        }
        // Names a ticket a recent note thread made or acts on: that thread, when
        // the triage says act (D66); context and skip stay as for any block.
        const named = namedThread(block.text, threads);
        fresh.push({ date, block, ...(named ? { named: named.id } : {}) });
      }
    }

    const taken = fresh.slice(0, NOTE_TRIAGE_MAX_BLOCKS);
    result.left += fresh.length - taken.length;
    // Blocks whose images wait are not sent, and nothing is recorded (D71).
    const batch: (Fresh & { modelText: string; triageText: string })[] = [];
    for (const f of taken) {
      const prepared = yield* forModel(f.block);
      if (prepared !== null)
        batch.push({ ...f, modelText: prepared.text, triageText: prepared.triageText });
    }
    /** The copies of blocks read in this reading take what their first was recorded as. */
    const followTwins = Effect.gen(function* () {
      if (!twins.length) return;
      const { byHash: now } = yield* recentBlocks(today);
      for (const t of twins) {
        const first = now.get(t.block.hash);
        if (first)
          yield* recordBlock(t.date, t.block, first.status, {
            inboxItemId: first.inboxItemId,
            workItemId: first.workItemId,
          });
      }
    });
    if (!batch.length) {
      yield* followTwins;
      yield* saveLastRead(result);
      return result;
    }

    const items = settings.work.enabled ? yield* candidateItems : [];
    const ids = items.map((i) => i.id);
    const listed = threads.slice(0, NOTE_THREADS_LISTED);
    const threadIds = listed.map((t) => t.id);
    result.called = true;
    const call = yield* Effect.either(
      llm.object<NoteTriageOutput>("note_triage", {
        schema: buildNoteTriageSchema(batch.length, ids, threadIds) as never,
        ...buildNoteTriagePrompt({
          blocks: batch.map((f) => ({
            // Each image's transcript clipped, so the user's words fit (D71).
            text: f.triageText,
            section: f.block.section,
            date: f.date,
          })),
          items,
          threads: listed.map((t) => ({
            id: t.id,
            date: t.date,
            summary: t.summary,
            tickets: [...t.created, ...t.acted],
          })),
          today,
        }),
        validate: (out) => validateNoteTriage(out, batch.length, ids, threadIds),
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
      // A named ticket's thread wins; else the model's, from the listed ones.
      const thread = decision.kind === "act" ? (f.named ?? decision.threadId) : null;
      const placed = { date: f.date, block: f.block, today, modelText: f.modelText };
      if (thread) {
        // A failed turn records nothing, so the next reading tries again.
        const r = yield* continueThread(intake, thread, placed);
        if (Either.isLeft(r)) logger.warn("Continuing a note thread failed", r.left);
        else result.continued++;
      } else if (decision.kind === "act") {
        // A failed triage leaves its thread with the error and a retry; it is not sent again.
        const { error } = yield* startThread(intake, placed);
        if (error) logger.warn("Reading a note block failed", error);
        result.cards++;
      } else if (decision.kind === "context") {
        // The user's words as written: a transcript is someone else's (D71).
        yield* addNote(decision.itemId, f.block.text);
        yield* recordBlock(f.date, f.block, "context", { workItemId: decision.itemId });
        result.notes.push(names.get(decision.itemId) ?? decision.itemId);
      } else {
        yield* recordBlock(f.date, f.block, "skipped");
        result.skippedBlocks++;
      }
    }
    yield* followTwins;
    yield* saveLastRead(result);
    if (result.cards || result.notes.length || result.revised || result.continued || result.closed)
      logger.info(
        `Daily note read: ${result.cards} cards, ${result.continued} continued, ${result.notes.length} notes, ${result.revised} revised, ${result.closed} closed, ${result.skippedBlocks} left alone`,
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
  if (r.continued) parts.push(`${r.continued} continued`);
  if (r.revised) parts.push(`${n(r.revised, "thread")} revised`);
  if (r.closed) parts.push(`${n(r.closed, "close")} proposed`);
  const byItem = new Map<string, number>();
  for (const name of r.notes) byItem.set(name, (byItem.get(name) ?? 0) + 1);
  for (const [name, count] of byItem) parts.push(`${n(count, "note")} on ${name}`);
  if (r.skippedBlocks) parts.push(`${r.skippedBlocks} left alone`);
  if (r.privateBlocks) parts.push(`${r.privateBlocks} private`);
  if (r.left) parts.push(`${r.left} for the next read`);
  if (r.waiting) parts.push(`${r.waiting} ${r.waiting === 1 ? "waits" : "wait"}: ${r.waitReason}`);
  const head = `Read at ${time(r.at)}`;
  if (r.error) return `${head}: could not read the new blocks (${r.error}).`;
  return parts.length ? `${head}: ${parts.join(", ")}.` : `${head}: nothing new.`;
}

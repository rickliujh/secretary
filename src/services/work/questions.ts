/**
 * The work model's questions (FR-19.4, D61): `needs_clarification` proposals
 * carrying `work`, with the choices code considered. A question about an Inbox
 * message goes in that message's thread, which the user has open; the rest go
 * in one `work` thread per item and are rationed (a setting, default three a
 * day), the most consequential first: an event whose words name a date, then
 * other events, then what the state update could not settle, then grouping
 * doubts. The answer arrives through `Intake.reply` and reaches the item; an
 * unanswered question expires after seven days with its event attached as
 * `unsure`, listed on the timeline and never read into the state.
 *
 * What the ration leaves unasked is kept for the day (`sync_state`
 * `work.unasked`), so the end-of-day pass can release up to five of them in
 * the same order (D63); a released question does not count against the ration.
 */
import { and, eq, gte, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { Effect } from "effect";
import { z } from "zod";
import {
  inboxItems,
  inboxMessages,
  proposals,
  workEvents,
  workItemIssues,
  workItems,
} from "@/db/schema";
import { localDate } from "@/lib/dates";
import { newId, nowIso } from "@/lib/ids";
import { readJson } from "@/lib/json";
import { query } from "@/services/db";
import { getState, SYNC_KEYS, setState } from "@/services/sync/state";
import type { AttachAsk } from "./attach";
import { appendEvents } from "./events";
import type { DoubtOfItems } from "./queries";
import { mergeItems, recordCorrection } from "./queries";
import {
  eventData,
  KEEP_APART,
  NONE_OF_THESE,
  ONE_PIECE,
  type WorkQuestion,
  WorkQuestionSchema,
} from "./schema";

/**
 * One writer at a time for the work threads, the ration's leftovers and the
 * end-of-day page (D63): the work pass's `askQuestions` and `runDayEnd` hold
 * it, so two runs never make two threads for one item, rewrite
 * `work.unasked` over each other or release a question twice. Not
 * re-entrant: code inside either calls the unlocked parts.
 */
export const questionLock = Effect.unsafeMakeSemaphore(1);

/** Days a question waits for an answer. */
export const QUESTION_DAYS = 7;

/** A question the state update asked about one item (what a commitment means). */
export type MeaningAsk = { itemId: string; question: string; choices: string[] };

const itemsById = (ids: readonly string[]) =>
  ids.length
    ? Effect.map(
        query((d) =>
          d
            .select()
            .from(workItems)
            .where(inArray(workItems.id, [...ids]))
            .all(),
        ),
        (rows) => new Map(rows.map((r) => [r.id, r])),
      )
    : Effect.succeed(new Map<string, typeof workItems.$inferSelect>());

const keysByItem = (ids: readonly string[]) =>
  Effect.map(
    ids.length
      ? query((d) =>
          d
            .select({ key: workItemIssues.issueKey, id: workItemIssues.workItemId })
            .from(workItemIssues)
            .where(inArray(workItemIssues.workItemId, [...ids]))
            .all(),
        )
      : Effect.succeed([] as { key: string; id: string }[]),
    (rows) => {
      const out = new Map<string, string[]>();
      for (const r of rows) out.set(r.id, [...(out.get(r.id) ?? []), r.key]);
      return out;
    },
  );

/** "Payment cert renewal (PAY-12, PLAT-812)": an item as a choice. */
const choiceLabel = (name: string, keys: readonly string[]) =>
  `${name}${keys.length ? ` (${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", ..." : ""})` : ""}`;

/** The item's own thread for questions, made on first use. */
export const workThread = (itemId: string, name: string) =>
  Effect.gen(function* () {
    const found = yield* query((d) =>
      d
        .select({ id: inboxItems.id })
        .from(inboxItems)
        // Outcome cards name their item too (Phase 25); the questions thread is the other one.
        .where(and(eq(inboxItems.workItemId, itemId), ne(inboxItems.source, "secretary")))
        .get(),
    );
    if (found) return found.id;
    const id = newId();
    yield* query((d) =>
      d.insert(inboxItems).values({
        id,
        source: "other",
        rawText: `Questions about the work item "${name}"`,
        receivedAt: nowIso(),
        status: "triaged",
        summary: `Work: ${name}`,
        workItemId: itemId,
      }),
    );
    return id;
  });

/** An assistant turn in a thread, after its last message. */
export const postMessage = (inboxItemId: string, summary: string) =>
  Effect.gen(function* () {
    const seq = yield* query((d) =>
      d
        .select({ n: sql<number>`coalesce(max(${inboxMessages.seq}), -1)` })
        .from(inboxMessages)
        .where(eq(inboxMessages.inboxItemId, inboxItemId))
        .get(),
    );
    const id = newId();
    yield* query((d) =>
      d.insert(inboxMessages).values({
        id,
        inboxItemId,
        seq: Number(seq?.n ?? -1) + 1,
        role: "assistant",
        content: { summary },
        createdAt: nowIso(),
      }),
    );
    return id;
  });

/** Posts one question in a thread: an assistant turn holding the pending question. */
export const postQuestion = (
  inboxItemId: string,
  q: {
    question: string;
    choices: string[];
    work: WorkQuestion;
    intro?: string;
    /** Released by the end-of-day pass on this local day (D63): outside the ration. */
    releasedOn?: string;
  },
) =>
  Effect.gen(function* () {
    const now = nowIso();
    const pseq = yield* query((d) =>
      d
        .select({ n: sql<number>`coalesce(max(${proposals.seq}), -1)` })
        .from(proposals)
        .where(eq(proposals.inboxItemId, inboxItemId))
        .get(),
    );
    const messageId = yield* postMessage(inboxItemId, q.intro ?? "A question about your work");
    const id = newId();
    yield* query((d) =>
      d.insert(proposals).values({
        id,
        inboxItemId,
        messageId,
        seq: Number(pseq?.n ?? -1) + 1,
        kind: "needs_clarification",
        payload: {
          kind: "needs_clarification",
          question: q.question,
          choices: q.choices,
          work: q.work,
          ...(q.releasedOn ? { releasedOn: q.releasedOn } : {}),
        },
        status: "pending",
        createdAt: now,
      }),
    );
    // A thread the user parked stays parked (D62): the question waits in it.
    yield* query((d) =>
      d
        .update(inboxItems)
        .set({ status: "triaged" })
        .where(and(eq(inboxItems.id, inboxItemId), ne(inboxItems.status, "parked"))),
    );
    return id;
  });

/**
 * Work questions asked in work threads since `since` (the ration counts these).
 * A question in a thread the user parked does not count (D62), nor one the
 * end-of-day pass released (D63).
 */
const askedSince = (since: string) =>
  Effect.map(
    query((d) =>
      d
        .select({ n: sql<number>`count(*)` })
        .from(proposals)
        .innerJoin(inboxItems, eq(inboxItems.id, proposals.inboxItemId))
        .where(
          and(
            eq(proposals.kind, "needs_clarification"),
            isNotNull(inboxItems.workItemId),
            ne(inboxItems.status, "parked"),
            gte(proposals.createdAt, since),
            sql`json_extract(${proposals.payload}, '$.work.type') IS NOT NULL`,
            sql`json_extract(${proposals.payload}, '$.releasedOn') IS NULL`,
          ),
        )
        .get(),
    ),
    (r) => Number(r?.n ?? 0),
  );

/** Work questions by the key they were asked under, any status: each is asked once. */
const askedKeys = Effect.map(
  query((d) =>
    d
      .select({ key: sql<string>`json_extract(${proposals.payload}, '$.work.key')` })
      .from(proposals)
      .where(
        and(
          eq(proposals.kind, "needs_clarification"),
          sql`json_extract(${proposals.payload}, '$.work.type') = 'group'`,
        ),
      )
      .all(),
  ),
  (rows) => new Set(rows.map((r) => r.key)),
);

export const doubtKey = (d: DoubtOfItems) => `group:${d.itemIds.join("|")}`;

const normalise = (q: string) =>
  q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
/** The same question, worded the same apart from case and punctuation. */
export const sameQuestion = (a: string, b: string) => normalise(a) === normalise(b);

/** Meaning questions: every pending one, and those asked since `since`. */
const meaningAsked = (since: string) =>
  Effect.map(
    query((d) =>
      d
        .select({
          payload: proposals.payload,
          status: proposals.status,
          createdAt: proposals.createdAt,
        })
        .from(proposals)
        .where(
          and(
            eq(proposals.kind, "needs_clarification"),
            sql`json_extract(${proposals.payload}, '$.work.type') = 'meaning'`,
            sql`(${proposals.status} = 'pending' OR ${proposals.createdAt} >= ${since})`,
          ),
        )
        .all(),
    ),
    (rows) =>
      rows.map((r) => {
        const p = r.payload as { question?: string; work?: { itemId?: string } };
        return {
          itemId: p.work?.itemId ?? "",
          question: p.question ?? "",
          pending: r.status === "pending",
        };
      }),
  );

/** A question that shares the day's ration; `rank` orders them (the most consequential first). */
export type Ask =
  | { type: "attach"; ask: AttachAsk; rank: number }
  | { type: "meaning"; ask: MeaningAsk; rank: number }
  | { type: "group"; ask: DoubtOfItems; rank: number };

/** The item whose work thread a rationed question goes in. */
const targetOf = (r: Ask) => (r.type === "meaning" ? r.ask.itemId : (r.ask.itemIds[0] ?? ""));

/** One key per question, so the day's unasked list holds each once. */
export const askKey = (r: Ask) =>
  r.type === "attach"
    ? `attach:${r.ask.eventId}`
    : r.type === "meaning"
      ? `meaning:${r.ask.itemId}:${normalise(r.ask.question)}`
      : doubtKey(r.ask);

/** Items among `ids` whose work thread the user parked (D62). */
const parkedItems = (ids: readonly string[]) =>
  Effect.map(
    ids.length
      ? query((d) =>
          d
            .select({ item: inboxItems.workItemId })
            .from(inboxItems)
            .where(
              and(
                inArray(inboxItems.workItemId, [...ids]),
                ne(inboxItems.source, "secretary"),
                eq(inboxItems.status, "parked"),
              ),
            )
            .all(),
        )
      : Effect.succeed([] as { item: string | null }[]),
    (rows) => new Set(rows.map((r) => r.item ?? "")),
  );

/** Posting over the items the questions name: their names and tickets read once. */
const asker = (ids: readonly string[]) =>
  Effect.gen(function* () {
    const items = yield* itemsById(ids);
    const keys = yield* keysByItem(ids);
    const nameOf = (id: string) => items.get(id)?.name ?? "Work item";

    const askAttach = (a: AttachAsk, inboxItemId: string, releasedOn?: string) =>
      Effect.gen(function* () {
        const choices = [
          ...a.itemIds.map((id) => choiceLabel(nameOf(id), keys.get(id) ?? [])),
          NONE_OF_THESE,
        ];
        const id = yield* postQuestion(inboxItemId, {
          question: `Which piece of work is this about: "${a.summary.slice(0, 160)}"? I see ${a.itemIds.map((i) => `"${nameOf(i)}"`).join(" and ")}.`,
          choices,
          work: { type: "attach", eventId: a.eventId, itemIds: a.itemIds },
          intro: "I am not sure which work item this belongs to",
          releasedOn,
        });
        const row = yield* query((d) =>
          d
            .select({ data: workEvents.data })
            .from(workEvents)
            .where(eq(workEvents.id, a.eventId))
            .get(),
        );
        yield* query((d) =>
          d
            .update(workEvents)
            .set({ data: { ...eventData(row?.data), question: id, candidates: a.itemIds } })
            .where(eq(workEvents.id, a.eventId)),
        );
        return id;
      });

    /** A rationed question, in its item's work thread. */
    const post = (r: Ask, releasedOn?: string) =>
      Effect.gen(function* () {
        if (r.type === "attach") {
          const first = r.ask.itemIds[0] ?? "";
          return yield* askAttach(r.ask, yield* workThread(first, nameOf(first)), releasedOn);
        }
        if (r.type === "meaning")
          return yield* postQuestion(yield* workThread(r.ask.itemId, nameOf(r.ask.itemId)), {
            question: r.ask.question,
            choices: r.ask.choices,
            work: { type: "meaning", itemId: r.ask.itemId },
            intro: `A question about "${nameOf(r.ask.itemId)}"`,
            releasedOn,
          });
        const [a, b] = r.ask.itemIds;
        return yield* postQuestion(yield* workThread(a, nameOf(a)), {
          question: `Are "${choiceLabel(nameOf(a), keys.get(a) ?? [])}" and "${choiceLabel(nameOf(b), keys.get(b) ?? [])}" one piece of work?${
            r.ask.reason === "cap"
              ? " Together they would be a large item, so I kept them apart."
              : " Their tickets are linked."
          }`,
          choices: [ONE_PIECE, KEEP_APART],
          work: { type: "group", key: doubtKey(r.ask), itemIds: [a, b] },
          intro: "Two work items may be one",
          releasedOn,
        });
      });
    return { askAttach, post, nameOf };
  });

/**
 * Asks what the pass could not settle. Questions about an Inbox message go in
 * its thread at once; the rest share the day's ration, most consequential first.
 * What the ration leaves is kept for the day, for the end-of-day pass (D63).
 */
export const askQuestions = (opts: {
  attach: readonly AttachAsk[];
  meaning: readonly MeaningAsk[];
  doubts: readonly DoubtOfItems[];
  perDay: number;
  /** Start of the user's day, ISO: the ration counts from here. */
  dayStart: string;
}) => questionLock.withPermits(1)(askUnlocked(opts));

const askUnlocked = (opts: {
  attach: readonly AttachAsk[];
  meaning: readonly MeaningAsk[];
  doubts: readonly DoubtOfItems[];
  perDay: number;
  dayStart: string;
}) =>
  Effect.gen(function* () {
    const ids = [
      ...new Set([
        ...opts.attach.flatMap((a) => a.itemIds),
        ...opts.meaning.map((m) => m.itemId),
        ...opts.doubts.flatMap((d) => d.itemIds),
      ]),
    ];
    const { askAttach, post } = yield* asker(ids);
    const asked: string[] = [];

    // In the thread the user is in: free, and asked at once.
    const rationed: Ask[] = [];
    for (const a of opts.attach) {
      if (a.inboxItemId) {
        const thread = yield* query((d) =>
          d
            .select({ id: inboxItems.id })
            .from(inboxItems)
            .where(eq(inboxItems.id, a.inboxItemId ?? ""))
            .get(),
        );
        if (thread) {
          asked.push(yield* askAttach(a, thread.id));
          continue;
        }
      }
      rationed.push({ type: "attach", ask: a, rank: a.datesNamed ? 0 : 1 });
    }
    // One open meaning question per item, and the same question not again within the week.
    const recent = yield* meaningAsked(
      new Date(Date.parse(opts.dayStart) - QUESTION_DAYS * 86_400_000).toISOString(),
    );
    for (const m of opts.meaning) {
      const mine = recent.filter((r) => r.itemId === m.itemId);
      if (mine.some((r) => r.pending || sameQuestion(r.question, m.question))) continue;
      recent.push({ itemId: m.itemId, question: m.question, pending: true });
      rationed.push({ type: "meaning", ask: m, rank: 2 });
    }
    const done = yield* askedKeys;
    for (const d of opts.doubts)
      if (!done.has(doubtKey(d))) rationed.push({ type: "group", ask: d, rank: 3 });

    // A work thread the user parked takes no new rationed question until it is
    // back (D62): its questions do not count, so they would not be rationed.
    const parked = yield* parkedItems(ids);
    const posted: string[] = [];
    const unasked: Ask[] = [];
    let left = Math.max(0, opts.perDay - (yield* askedSince(opts.dayStart)));
    for (const r of rationed.sort((a, b) => a.rank - b.rank)) {
      // Kept for the end of day, which releases it if the thread is back by then.
      if (parked.has(targetOf(r)) || left <= 0) {
        unasked.push(r);
        continue;
      }
      left--;
      asked.push(yield* post(r));
      posted.push(askKey(r));
    }
    yield* keepUnasked(localDate(new Date(opts.dayStart)), unasked, posted);
    return asked;
  });

// ---------------------------------------------------------------------------
// What the ration left unasked (D63)
// ---------------------------------------------------------------------------

const StoredAskSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("attach"),
    rank: z.number(),
    ask: z.object({
      eventId: z.string(),
      itemIds: z.array(z.string()).min(1),
      inboxItemId: z.string().nullable().default(null),
      datesNamed: z.boolean().default(false),
      summary: z.string(),
      // The event's words stay in the event; the question shows only its summary.
      text: z.string().default(""),
    }),
  }),
  z.object({
    type: z.literal("meaning"),
    rank: z.number(),
    ask: z.object({
      itemId: z.string(),
      question: z.string(),
      choices: z.array(z.string()).default([]),
    }),
  }),
  z.object({
    type: z.literal("group"),
    rank: z.number(),
    ask: z.object({
      reason: z.enum(["cap", "items"]),
      itemIds: z.tuple([z.string(), z.string()]),
    }),
  }),
]);

/** `sync_state` `work.unasked`: the day's questions over the ration, in the order found. */
const UnaskedSchema = z.object({
  day: z.string(),
  asks: z.array(StoredAskSchema).default([]),
});

const stored = (r: Ask): Ask => (r.type === "attach" ? { ...r, ask: { ...r.ask, text: "" } } : r);

/** The day's unasked questions; another day's list is empty. */
export const unaskedOf = (today: string) =>
  Effect.map(getState(SYNC_KEYS.unasked), (raw) => {
    const v = readJson(raw, UnaskedSchema, { day: today, asks: [] });
    return v.day === today ? (v.asks as Ask[]) : [];
  });

/** Most questions kept for the day; the oldest go first. */
export const UNASKED_LIMIT = 50;

const saveUnasked = (today: string, asks: readonly Ask[]) =>
  setState(
    SYNC_KEYS.unasked,
    JSON.stringify({ day: today, asks: asks.slice(-UNASKED_LIMIT).map(stored) }),
  );

/**
 * Keeps what the ration left today: the earlier list without what was just
 * asked, with this pass's leftovers in place of the same questions. Attach and
 * grouping questions come back every pass while they stand; a meaning
 * question is found once, so it is kept here until the day ends.
 */
const keepUnasked = (today: string, unasked: readonly Ask[], asked: readonly string[]) =>
  Effect.gen(function* () {
    const before = yield* unaskedOf(today);
    if (before.length === 0 && unasked.length === 0) return;
    const gone = new Set([...asked, ...unasked.map(askKey)]);
    yield* saveUnasked(today, [...before.filter((r) => !gone.has(askKey(r))), ...unasked]);
  });

/** Whether a question kept for later still needs asking. */
/**
 * Whether a work question still has something to settle: its event is still
 * unattached (attach), its items are still active. A released question whose
 * answer no longer matters is withdrawn on the next end-of-day run (D63).
 */
export const questionStands = (q: WorkQuestion) =>
  Effect.gen(function* () {
    const ids = q.type === "meaning" ? [q.itemId] : q.itemIds;
    const items = yield* itemsById(ids);
    const active = (id: string) => items.get(id)?.status === "active";
    if (q.type === "attach") {
      const e = yield* query((d) =>
        d.select().from(workEvents).where(eq(workEvents.id, q.eventId)).get(),
      );
      return !!e && e.attachedBy === null && ids.some(active);
    }
    return ids.every(active);
  });

const askOf = (r: Ask): WorkQuestion =>
  r.type === "attach"
    ? { type: "attach", eventId: r.ask.eventId, itemIds: r.ask.itemIds }
    : r.type === "meaning"
      ? { type: "meaning", itemId: r.ask.itemId }
      : { type: "group", key: doubtKey(r.ask), itemIds: r.ask.itemIds };

const stillOpen = (r: Ask, today: string) =>
  Effect.gen(function* () {
    if (!(yield* questionStands(askOf(r)))) return false;
    if (r.type === "attach") {
      // A question about it is out already.
      const e = yield* query((d) =>
        d.select().from(workEvents).where(eq(workEvents.id, r.ask.eventId)).get(),
      );
      return !eventData(e?.data).question;
    }
    if (r.type === "group") return !(yield* askedKeys).has(doubtKey(r.ask));
    const since = new Date(
      Date.parse(`${today}T00:00:00`) - QUESTION_DAYS * 86_400_000,
    ).toISOString();
    const recent = (yield* meaningAsked(since)).filter((x) => x.itemId === r.ask.itemId);
    return !recent.some((x) => x.pending || sameQuestion(x.question, r.ask.question));
  });

/**
 * The end-of-day pass's release (D63): up to `limit` of the day's questions
 * the ration left unasked, most consequential first, posted in their items'
 * work threads as the pass would have, marked `releasedOn` so the ration does
 * not count them. A question whose thread the user parked stays for later;
 * one that no longer stands is dropped. Returns the posted proposal ids.
 * The caller holds `questionLock` (`runDayEnd` does).
 */
export const releaseUnasked = (opts: { today: string; limit: number }) =>
  Effect.gen(function* () {
    const all = yield* unaskedOf(opts.today);
    if (all.length === 0 || opts.limit <= 0) return [] as string[];
    const order = [...all].sort((a, b) => a.rank - b.rank);
    const ids = [
      ...new Set(order.flatMap((r) => (r.type === "meaning" ? [r.ask.itemId] : r.ask.itemIds))),
    ];
    const parked = yield* parkedItems(ids);
    const { post } = yield* asker(ids);
    const released: string[] = [];
    const keep: Ask[] = [];
    for (const r of order) {
      if (released.length >= opts.limit || parked.has(targetOf(r))) {
        keep.push(r);
        continue;
      }
      if (!(yield* stillOpen(r, opts.today))) continue;
      released.push(yield* post(r, opts.today));
    }
    yield* saveUnasked(opts.today, keep);
    return released;
  });

// ---------------------------------------------------------------------------
// Expiry and answers
// ---------------------------------------------------------------------------

/** Settles an attach question's event as unsure: on the first item's timeline, never in its state. */
const settleUnsure = (q: Extract<WorkQuestion, { type: "attach" }>) =>
  query((d) =>
    d
      .update(workEvents)
      .set({ workItemId: q.itemIds[0] ?? null, attachedBy: "unsure", applied: true })
      .where(and(eq(workEvents.id, q.eventId), sql`${workEvents.attachedBy} IS NULL`)),
  );

const pendingWorkQuestions = query((d) =>
  d
    .select()
    .from(proposals)
    .where(
      and(
        eq(proposals.kind, "needs_clarification"),
        inArray(proposals.status, ["pending", "rejected"]),
        sql`json_extract(${proposals.payload}, '$.work.type') IS NOT NULL`,
        // A rejected one is settled once, then left alone.
        sql`json_extract(${proposals.result}, '$.settled') IS NULL`,
      ),
    )
    .all(),
);

/**
 * Questions unanswered for seven days expire, and a skipped one is settled the
 * same way: an attach question's event goes on the first item's timeline as
 * `unsure`.
 */
export const expireQuestions = (now = new Date()) =>
  Effect.gen(function* () {
    const cutoff = new Date(now.getTime() - QUESTION_DAYS * 86_400_000).toISOString();
    let expired = 0;
    for (const row of yield* pendingWorkQuestions) {
      const q = WorkQuestionSchema.safeParse((row.payload as { work?: unknown }).work);
      if (!q.success) continue;
      if (row.status === "pending") {
        if (row.createdAt > cutoff) continue;
        yield* query((d) =>
          d
            .update(proposals)
            .set({
              status: "rejected",
              decidedAt: nowIso(),
              result: { expired: true, settled: true },
            })
            .where(eq(proposals.id, row.id)),
        );
        expired++;
      } else
        yield* query((d) =>
          d
            .update(proposals)
            .set({ result: { ...((row.result as object | null) ?? {}), settled: true } })
            .where(eq(proposals.id, row.id)),
        );
      if (q.data.type === "attach") yield* settleUnsure(q.data);
    }
    return expired;
  });

const clean = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Which choice an answer means: its index, or -1 when it cannot be told (pure). */
export function matchChoice(
  answer: string,
  choices: readonly string[],
  extra: readonly { keys: readonly string[]; name: string }[] = [],
): number {
  const a = clean(answer);
  if (!a) return -1;
  const exact = choices.findIndex((c) => clean(c) === a);
  if (exact >= 0) return exact;
  const n = /^(\d+)$/.exec(a);
  if (n) {
    const i = Number(n[1]) - 1;
    return i >= 0 && i < choices.length ? i : -1;
  }
  const keys = answer.toUpperCase().match(/\b[A-Z][A-Z0-9_]+-\d+\b/g) ?? [];
  const byKey = extra
    .map((e, i) => (keys.some((k) => e.keys.includes(k)) ? i : -1))
    .filter((i) => i >= 0);
  if (byKey.length === 1) return byKey[0] ?? -1;
  const byName = extra
    .map((e, i) => {
      const name = clean(e.name);
      return name && (a.includes(name) || (a.length >= 4 && name.includes(a))) ? i : -1;
    })
    .filter((i) => i >= 0);
  if (byName.length === 1) return byName[0] ?? -1;
  return -1;
}

const NO = /^(no|nope|none|neither|not these|none of (them|these)|new|something else)\b/;
const YES = /^(yes|yep|yeah|same|one|correct|right)\b/;

export type WorkAnswer = { message: string; reask: boolean };

/**
 * Applies the user's answer to a work question (through `Intake.reply`): an
 * event attached to the item named, two items merged or kept apart (a
 * correction), or the answer as an event the next state update reads. An
 * answer that matches no choice asks the question again.
 */
export const answerWorkQuestion = (row: typeof proposals.$inferSelect, answer: string) =>
  Effect.gen(function* () {
    const payload = row.payload as {
      question?: string;
      choices?: string[];
      work?: unknown;
      releasedOn?: string;
    };
    const q = WorkQuestionSchema.parse(payload.work);
    const choices = payload.choices ?? [];
    const again = (message: string) =>
      Effect.gen(function* () {
        if (row.inboxItemId)
          yield* postQuestion(row.inboxItemId, {
            question: payload.question ?? "Which one?",
            choices,
            work: q,
            intro: message,
            // A released question asked again stays outside the ration (D63).
            releasedOn: payload.releasedOn,
          });
        return { message, reask: true } satisfies WorkAnswer;
      });
    if (q.type === "attach") {
      const items = yield* itemsById(q.itemIds);
      const keys = yield* keysByItem(q.itemIds);
      const extra = q.itemIds.map((id) => ({
        keys: keys.get(id) ?? [],
        name: items.get(id)?.name ?? "",
      }));
      const i = matchChoice(answer, choices, extra);
      const none = i === choices.length - 1 || (i < 0 && NO.test(clean(answer)));
      if (none) {
        yield* query((d) =>
          d
            .update(workEvents)
            .set({ attachedBy: "none", applied: true })
            .where(eq(workEvents.id, q.eventId)),
        );
        return { message: "Noted: it belongs to none of them.", reask: false } satisfies WorkAnswer;
      }
      const itemId = i >= 0 ? q.itemIds[i] : undefined;
      if (!itemId)
        return yield* again("I could not tell which you meant. Pick one of the choices.");
      yield* query((d) =>
        d
          .update(workEvents)
          .set({ workItemId: itemId, attachedBy: "answer", applied: false })
          .where(eq(workEvents.id, q.eventId)),
      );
      return {
        message: `Added to "${items.get(itemId)?.name ?? "the item"}".`,
        reask: false,
      } satisfies WorkAnswer;
    }
    if (q.type === "group") {
      const [a, b] = q.itemIds;
      const i = matchChoice(answer, choices);
      const yes = i === 0 || (i < 0 && YES.test(clean(answer)));
      const no = i === 1 || (i < 0 && NO.test(clean(answer)));
      if (yes) {
        yield* mergeItems(b, a, "answer");
        return { message: "Merged them into one work item.", reask: false } satisfies WorkAnswer;
      }
      if (no) {
        const keys = yield* keysByItem([a, b]);
        const ka = keys.get(a) ?? [];
        const kb = keys.get(b) ?? [];
        if (ka.length && kb.length)
          yield* recordCorrection(
            a,
            { type: "apart", keys: ka, from: kb },
            `${ka.join(", ")} is separate from ${kb.join(", ")}`,
            "answer",
          );
        return { message: "Kept them apart.", reask: false } satisfies WorkAnswer;
      }
      return yield* again("Answer yes or no, or pick a choice.");
    }
    // What the state update could not settle: the answer is the user's word on it.
    yield* appendEvents([
      {
        kind: "answer",
        actor: "me",
        summary: `Answered "${(payload.question ?? "").slice(0, 120)}": ${answer.slice(0, 200)}`,
        data: { text: `Question: ${payload.question ?? ""}\nAnswer: ${answer}` },
        workItemId: q.itemId,
        attachedBy: "answer",
      },
    ]);
    return { message: "Thanks, noted.", reask: false } satisfies WorkAnswer;
  });

/** One key per work question, the same for a question and its re-ask. */
export const workQuestionKey = (q: WorkQuestion) =>
  q.type === "attach" ? `attach:${q.eventId}` : q.type === "group" ? q.key : `meaning:${q.itemId}`;

/**
 * Work questions the end-of-day pass released on `today` (D63), any status,
 * a re-ask counted with its question: five a day at most.
 */
export const releasedOn = (today: string) =>
  Effect.map(
    query((d) =>
      d
        .select({ thread: proposals.inboxItemId, payload: proposals.payload })
        .from(proposals)
        .where(
          and(
            eq(proposals.kind, "needs_clarification"),
            sql`json_extract(${proposals.payload}, '$.releasedOn') = ${today}`,
          ),
        )
        .all(),
    ),
    (rows) =>
      new Set(
        rows.flatMap((r) => {
          const q = WorkQuestionSchema.safeParse((r.payload as { work?: unknown }).work);
          return q.success ? [`${r.thread}|${workQuestionKey(q.data)}`] : [];
        }),
      ).size,
  );

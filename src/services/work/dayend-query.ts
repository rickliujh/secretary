/**
 * The end-of-day pass (FR-19.9, D63): reads what the page needs, releases the
 * questions the ration left unasked, and keeps one `secretary` Inbox item a
 * day (`situation_key` `day_end:<date>`). Run from the webview when the user
 * clicks "End of day" on Today, from the chat's `day_end`, or at the set time
 * while the app is open (`src/app/work.ts`). No model call, no Jira write.
 *
 * A rerun the same day replaces the page and looks at the questions again:
 * those released earlier that are still open and still stand stay (a re-ask
 * in place of the question it repeats), ones that no longer stand are taken
 * back in their threads, answered ones drop off, and more are released up to
 * five a day. Runs hold `questionLock`, shared with the work pass's questions. Marking the item done files it; its questions stay
 * answerable in their work threads. Each item the page names gets one
 * `day_end` event a day, already applied, so the state update never reads it.
 */
import { and, eq, gte, inArray, like, ne, type SQL, sql } from "drizzle-orm";
import { Effect } from "effect";
import { z } from "zod";
import {
  communications,
  inboxItems,
  people,
  proposals,
  teams,
  workEvents,
  workItemIssues,
  workItems,
} from "@/db/schema";
import { localDate } from "@/lib/dates";
import { newId, nowIso } from "@/lib/ids";
import { logger } from "@/lib/log";
import { query } from "@/services/db";
import { Settings, settingsOrDefault } from "@/services/settings";
import {
  DAY_END_QUESTIONS,
  type DayEndDraft,
  type DayEndEvent,
  type DayEndPage,
  dayEnd,
  dayLabel,
} from "./dayend";
import { appendEvents } from "./events";
import { type ItemFacts, loadItemFacts } from "./facts";
import { pendingOutcomes } from "./outcomes";
import { currentItem } from "./park";
import { actorName, dayStartIso, ownWords } from "./pass";
import {
  postMessage,
  questionLock,
  questionStands,
  releasedOn,
  releaseUnasked,
  workQuestionKey,
} from "./questions";
import {
  eventText,
  parseState,
  TIMELINE_ONLY,
  type WorkQuestion,
  WorkQuestionSchema,
} from "./schema";

/** The day's item: one per local day. */
export const dayEndKey = (today: string) => `day_end:${today}`;

/** What the day's item keeps in `inbox_items.triage`. */
export const DayEndRecordSchema = z.object({
  dayEnd: z.object({
    date: z.string(),
    tomorrow: z.string(),
    /** The work questions listed beside the page, in order (their proposal ids). */
    questionIds: z.array(z.string()).default([]),
    /** The items the page names. */
    itemIds: z.array(z.string()).default([]),
    counts: z.record(z.string(), z.number()).default({}),
    /** When the page was last written. */
    at: z.string(),
  }),
});
export type DayEndRecord = z.infer<typeof DayEndRecordSchema>["dayEnd"];

/** The end-of-day record of an Inbox item's triage, or null when it is no day's page. */
export function dayEndOf(triage: unknown): DayEndRecord | null {
  const r = DayEndRecordSchema.safeParse(triage);
  return r.success ? r.data.dayEnd : null;
}

export type DayEndTrigger = "button" | "chat" | "time";

export type DayEndResult =
  | { skipped: "disabled" }
  /** The timed run found the day's page already written. */
  | { skipped: "ran"; id: string }
  | {
      skipped?: undefined;
      id: string;
      /** False when the day's page was replaced. */
      created: boolean;
      page: DayEndPage;
      /** Questions released by this run. */
      released: number;
      /** The questions the page lists, as the chat tells them. */
      questions: { question: string; choices: string[]; item: string | null }[];
    };

/** The day's page, if written. */
export const dayEndItem = (today: string) =>
  query((d) =>
    d
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.situationKey, dayEndKey(today)))
      .get(),
  );

/** Whether the pass ran on this local day (the timed run then waits for the next). */
export const dayEndRanOn = (today: string) => Effect.map(dayEndItem(today), (r) => !!r);

/** The events of today the page shows: attached to an active item, not timeline-only. */
const eventsToday = (
  itemIds: readonly string[],
  now: Date,
  today: string,
  contacts: ReadonlyMap<string, string>,
) =>
  Effect.gen(function* () {
    if (itemIds.length === 0) return [] as DayEndEvent[];
    // A little before midnight too: Jira times may carry another offset.
    const since = new Date(Date.parse(dayStartIso(now)) - 86_400_000).toISOString();
    const rows = yield* query((d) =>
      d
        .select()
        .from(workEvents)
        .where(
          and(
            inArray(workEvents.workItemId, [...itemIds]),
            gte(workEvents.at, since),
            inArray(workEvents.attachedBy, ["code", "model", "user", "answer"]),
          ),
        )
        .all(),
    );
    return rows.flatMap((e): DayEndEvent[] => {
      if (TIMELINE_ONLY.has(e.kind as never)) return [];
      const ms = Date.parse(e.at);
      const at = Number.isNaN(ms) ? null : new Date(ms);
      if ((at ? localDate(at) : e.at.slice(0, 10)) !== today) return [];
      const time = at
        ? `${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`
        : "";
      return [
        {
          itemId: e.workItemId ?? "",
          kind: e.kind,
          at: at?.toISOString() ?? e.at,
          time,
          actor: actorName(e.actor, contacts),
          summary: e.summary,
          text: eventText(e),
          ownWords: ownWords(e),
          mine: e.actor === "me",
        },
      ];
    });
  });

/** Drafts not marked sent, with the active item of their first ticket. */
const unsentDrafts = Effect.gen(function* () {
  const rows = yield* query((d) =>
    d
      .select({ c: communications, person: people.displayName, team: teams.name })
      .from(communications)
      .leftJoin(people, eq(people.id, communications.recipientPersonId))
      .leftJoin(teams, eq(teams.id, communications.recipientTeamId))
      .where(ne(communications.status, "sent"))
      .all(),
  );
  const keys = [...new Set(rows.flatMap((r) => r.c.issueKeys))];
  const owner = new Map(
    keys.length
      ? (yield* query((d) =>
          d
            .select({ key: workItemIssues.issueKey, id: workItems.id })
            .from(workItemIssues)
            .innerJoin(workItems, eq(workItems.id, workItemIssues.workItemId))
            .where(and(inArray(workItemIssues.issueKey, keys), eq(workItems.status, "active")))
            .all(),
        )).map((r) => [r.key, r.id] as const)
      : [],
  );
  return rows.map(
    ({ c, person, team }): DayEndDraft => ({
      id: c.id,
      intent: c.intent,
      recipient: person ?? team ?? null,
      issueKeys: c.issueKeys,
      createdAt: c.createdAt,
      itemId: c.issueKeys.map((k) => owner.get(k)).find((x) => !!x) ?? null,
    }),
  );
});

/** A listed question as the page and the chat show it. */
export type DayEndQuestion = {
  id: string;
  /** The work thread it was posted in, where its answer goes (`Intake.reply`). */
  threadId: string | null;
  itemId: string | null;
  itemName: string | null;
  question: string;
  choices: string[];
  status: string;
  /** What the user answered, once they did. */
  answer: string | null;
  work: WorkQuestion | null;
};

const questionRows = (where: SQL | undefined) =>
  query((d) =>
    d
      .select({
        id: proposals.id,
        threadId: proposals.inboxItemId,
        payload: proposals.payload,
        status: proposals.status,
        result: proposals.result,
        createdAt: proposals.createdAt,
        itemId: inboxItems.workItemId,
        itemName: workItems.name,
      })
      .from(proposals)
      .leftJoin(inboxItems, eq(inboxItems.id, proposals.inboxItemId))
      .leftJoin(workItems, eq(workItems.id, inboxItems.workItemId))
      .where(where)
      .all(),
  );
type QuestionRow = Effect.Effect.Success<ReturnType<typeof questionRows>>[number];

const workOf = (payload: unknown) => {
  const q = WorkQuestionSchema.safeParse((payload as { work?: unknown } | null)?.work);
  return q.success ? q.data : null;
};

const toQuestion = (r: QuestionRow): DayEndQuestion => {
  const p = r.payload as { question?: string; choices?: string[] };
  return {
    id: r.id,
    threadId: r.threadId,
    itemId: r.itemId,
    itemName: r.itemName,
    question: p.question ?? "",
    choices: p.choices ?? [],
    status: r.status,
    answer: (r.result as { answer?: string } | null)?.answer ?? null,
    work: workOf(r.payload),
  };
};

/**
 * The questions of a day's page, in its order. An answer that matched no
 * choice asks again in the same thread: the pending re-ask is shown in place
 * of the question it repeats.
 */
export const dayEndQuestions = (ids: readonly string[]) =>
  Effect.gen(function* () {
    if (ids.length === 0) return [] as DayEndQuestion[];
    const rows = yield* questionRows(inArray(proposals.id, [...ids]));
    const threads = [...new Set(rows.flatMap((r) => (r.threadId ? [r.threadId] : [])))];
    const open = threads.length
      ? (yield* questionRows(
          and(
            inArray(proposals.inboxItemId, threads),
            eq(proposals.kind, "needs_clarification"),
            eq(proposals.status, "pending"),
          ),
        )).filter((r) => !ids.includes(r.id))
      : [];
    const keyOf = (r: QuestionRow) => {
      const w = workOf(r.payload);
      return w ? `${r.threadId}|${workQuestionKey(w)}` : null;
    };
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((id): DayEndQuestion[] => {
      const r = byId.get(id);
      if (!r) return [];
      if (r.status !== "pending") {
        const key = keyOf(r);
        const again = open
          .filter((o) => key && keyOf(o) === key && o.createdAt >= r.createdAt)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
        if (again) return [toQuestion(again)];
      }
      return [toQuestion(r)];
    });
  });

/**
 * Takes back a released question that no longer has anything to settle (its
 * event was attached since, its item closed): rejected in its thread with a
 * line saying why, settled so it never expires into the timeline.
 */
const withdraw = (q: DayEndQuestion) =>
  Effect.gen(function* () {
    yield* query((d) =>
      d
        .update(proposals)
        .set({
          status: "rejected",
          decidedAt: nowIso(),
          result: { settled: true, withdrawn: true },
        })
        .where(and(eq(proposals.id, q.id), eq(proposals.status, "pending"))),
    );
    if (q.threadId)
      yield* postMessage(q.threadId, `No longer needed, so I took it back: "${q.question}"`);
  });

/**
 * Runs the end-of-day pass (D63). The timed run does nothing when the day's
 * page is written already; the button and the chat write it again.
 */
export const runDayEnd = (opts: { now?: Date; trigger?: DayEndTrigger } = {}) =>
  questionLock.withPermits(1)(dayEndUnlocked(opts));

const dayEndUnlocked = (opts: { now?: Date; trigger?: DayEndTrigger }) =>
  Effect.gen(function* () {
    const now = opts.now ?? new Date();
    const today = localDate(now);
    const settings = yield* settingsOrDefault(yield* Settings);
    if (!settings.work.enabled) return { skipped: "disabled" } satisfies DayEndResult;
    const existing = yield* dayEndItem(today);
    if (existing && opts.trigger === "time")
      return { skipped: "ran", id: existing.id } satisfies DayEndResult;

    const active = yield* query((d) =>
      d.select().from(workItems).where(eq(workItems.status, "active")).all(),
    );
    const current = yield* currentItem(today);
    const ids = active.map((i) => i.id);
    const facts = new Map<string, ItemFacts>();
    for (const id of ids) facts.set(id, yield* loadItemFacts(id, { today }));
    const contacts = new Map(
      (yield* query((d) =>
        d.select({ id: people.id, name: people.displayName }).from(people).all(),
      )).map((p) => [p.id, p.name] as const),
    );
    const events = yield* eventsToday(ids, now, today, contacts);
    const drafts = yield* unsentDrafts;
    const cards = (yield* pendingOutcomes).map((c) => ({
      id: c.id,
      itemId: c.workItemId,
      itemName: c.itemName,
      title: c.title,
    }));

    // The questions: those released earlier today that still stand and are
    // open, then more, up to five released a day.
    const earlier = existing ? (dayEndOf(existing.triage)?.questionIds ?? []) : [];
    const open: DayEndQuestion[] = [];
    for (const q of yield* dayEndQuestions(earlier)) {
      if (q.status !== "pending") continue;
      if (q.work && !(yield* questionStands(q.work))) yield* withdraw(q);
      else open.push(q);
    }
    const released = yield* releaseUnasked({
      today,
      limit: DAY_END_QUESTIONS - (yield* releasedOn(today)),
    });
    const questions = [...open, ...(yield* dayEndQuestions(released))];

    const page = dayEnd({
      today,
      now: now.toISOString(),
      items: active.map((i) => ({
        id: i.id,
        name: i.name,
        current: current?.id === i.id,
        state: parseState(i.state),
        needsLook: i.needsLook,
      })),
      events,
      facts,
      contacts,
      drafts,
      cards,
      questions,
    });

    const at = nowIso();
    const record: DayEndRecord = {
      date: today,
      tomorrow: page.tomorrow,
      questionIds: questions.map((q) => q.id),
      itemIds: page.itemIds,
      counts: page.counts,
      at,
    };
    const summary = `End of day, ${page.title}`;
    // One row a day, whoever writes it: an insert that updates the day's row.
    const written = yield* query((d) =>
      d
        .insert(inboxItems)
        .values({
          id: newId(),
          source: "secretary",
          rawText: page.markdown,
          receivedAt: at,
          status: "triaged",
          summary,
          triage: { dayEnd: record },
          situationKey: dayEndKey(today),
        })
        .onConflictDoUpdate({
          target: inboxItems.situationKey,
          targetWhere: sql`${inboxItems.situationKey} IS NOT NULL`,
          set: {
            rawText: page.markdown,
            summary,
            triage: { dayEnd: record },
            receivedAt: at,
            status: "triaged",
          },
        })
        .returning({ id: inboxItems.id })
        .get(),
    );
    const id = written?.id ?? existing?.id ?? "";

    // One `day_end` event a day on each item the page names, for its timeline.
    const marked = new Set(
      (yield* query((d) =>
        d
          .select({ item: workEvents.workItemId })
          .from(workEvents)
          .where(and(eq(workEvents.kind, "day_end"), eq(workEvents.ref, id)))
          .all(),
      )).map((r) => r.item),
    );
    yield* appendEvents(
      page.itemIds
        .filter((itemId) => !marked.has(itemId))
        .map((itemId) => ({
          kind: "day_end" as const,
          actor: "secretary" as const,
          ref: id,
          summary: `In the end of day for ${dayLabel(today)}`,
          data: { inboxItemId: id },
          workItemId: itemId,
          attachedBy: "code" as const,
          applied: true,
        })),
    );
    logger.info(
      `End of day: ${page.itemIds.length} items, ${questions.length} questions (${released.length} released)`,
    );
    return {
      id,
      created: !existing,
      page,
      released: released.length,
      questions: questions.map((q) => ({
        question: q.question,
        choices: q.choices,
        item: q.itemName,
      })),
    } satisfies DayEndResult;
  });

/** "Done" on the day's page: it is filed; its questions stay open in their threads. */
export const closeDayEnd = (id: string) =>
  query((d) =>
    d
      .update(inboxItems)
      .set({ status: "filed" })
      .where(
        and(
          eq(inboxItems.id, id),
          eq(inboxItems.source, "secretary"),
          like(inboxItems.situationKey, "day_end:%"),
        ),
      ),
  ).pipe(Effect.asVoid);

/**
 * The work pass (D61): after a sync, a triage, an approval or a revoke (the
 * webview debounces it to one run a minute, `src/app/work.ts`). In order:
 *
 * 1. Grouping: new active tickets join or start items; items close and reopen.
 * 2. Questions past their time expire; skipped ones are settled.
 * 3. Waiting events are attached (code first, `attach_event` when it must).
 * 4. A note the user wrote is released when a fact it names changed.
 * 5. One `update_work_state` call per active item with unapplied events, the
 *    current item first, within the day's budget. A result that fails code's
 *    checks after one repair leaves the previous state with `needs_look`.
 * 6. What could not be settled is asked, rationed.
 * 7. The consequence rules run for the active items and offer outcome cards
 *    (Phase 25, `outcomes.ts`), even when no model call was made.
 *
 * Right after the grouping, an item current since an earlier day stops being
 * current, and parked Inbox threads come back when the current item changed
 * or closed, or their day is over (D62, `park.ts`).
 *
 * Nothing here writes to Jira. A pass with no new events makes no model call.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { Effect, Either } from "effect";
import { llmCalls, people, workEvents, workItems } from "@/db/schema";
import { localDate } from "@/lib/dates";
import { nowIso } from "@/lib/ids";
import { logger } from "@/lib/log";
import {
  buildWorkStatePrompt,
  buildWorkStateSchema,
  type StateEvent,
  toWorkState,
  validateWorkState,
  type WorkStateInput,
  type WorkStateOutput,
} from "@/prompts/work-state";
import { query } from "@/services/db";
import { Llm } from "@/services/llm";
import { Settings, settingsOrDefault } from "@/services/settings";
import { attachPending } from "./attach";
import { appendEvents } from "./events";
import { loadItemFacts } from "./facts";
import { noteStillHolds } from "./note";
import { runOutcomes } from "./outcomes";
import { returnParked, settleCurrent } from "./park";
import { regroup } from "./queries";
import { askQuestions, expireQuestions, type MeaningAsk } from "./questions";
import {
  eventData,
  eventText,
  MessageDataSchema,
  parseState,
  TIMELINE_ONLY,
  type WorkState,
} from "./schema";

/** Most events folded into one state update; the rest wait for the next pass. */
export const MAX_EVENTS_PER_CALL = 30;

export type PassResult = {
  skipped?: "disabled";
  created: number;
  attached: number;
  calls: number;
  failed: number;
  /** Items left for a later pass because the day's budget ran out. */
  deferred: number;
  asked: number;
  /** Outcome cards offered (Phase 25). */
  offered: number;
  /** Parked Inbox threads that came back (D62). */
  returned: number;
};

/** Start of the local day `now` is in, as an ISO time (the budgets count from here). */
export const dayStartIso = (now: Date) =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

/** State updates made since `since` (first attempts; repairs and escalations are part of them). */
export const stateCallsSince = (since: string) =>
  Effect.map(
    query((d) =>
      d
        .select({ n: sql<number>`count(*)` })
        .from(llmCalls)
        .where(
          and(
            eq(llmCalls.task, "update_work_state"),
            eq(llmCalls.repair, false),
            eq(llmCalls.escalated, false),
            gte(llmCalls.at, since),
          ),
        )
        .get(),
    ),
    (r) => Number(r?.n ?? 0),
  );

/** Active items with events to fold in: the current item first, then the latest news. */
const itemsToUpdate = query((d) =>
  d
    .select({
      id: workItems.id,
      current: workItems.current,
      last: sql<string>`max(${workEvents.at})`,
    })
    .from(workEvents)
    .innerJoin(workItems, eq(workItems.id, workEvents.workItemId))
    .where(
      and(
        eq(workItems.status, "active"),
        eq(workEvents.applied, false),
        isNotNull(workEvents.attachedBy),
        inArray(workEvents.attachedBy, ["code", "model", "user", "answer"]),
      ),
    )
    .groupBy(workItems.id)
    .orderBy(desc(workItems.current), desc(sql`max(${workEvents.at})`))
    .all(),
);

/** How an event's actor reads in a prompt or the chat. */
export const actorName = (actor: string, contacts: ReadonlyMap<string, string>) => {
  if (actor === "me") return "the user";
  if (actor === "sync") return "Jira";
  if (actor === "unknown") return "someone";
  if (actor === "secretary") return "the secretary";
  if (actor.startsWith("contact:")) return contacts.get(actor.slice(8)) ?? "a contact";
  if (actor.startsWith("jira:")) return actor.slice(5);
  return actor;
};

/** The user's own words: a note, an answer, their typed input, their edit. */
export const ownWords = (e: Pick<typeof workEvents.$inferSelect, "kind" | "data">) => {
  if (["note", "answer", "ticket_edited", "wait_dropped"].includes(e.kind)) return true;
  if (e.kind !== "message") return false;
  const m = MessageDataSchema.safeParse(e.data);
  return m.success && m.data.ownWords;
};

type UpdateOutcome =
  | { status: "updated"; question: MeaningAsk | null }
  | { status: "noop" }
  | { status: "failed" }
  | { status: "stopped"; message: string };

/** One state update for one item (D61). */
export const updateItemState = (itemId: string, opts: { today: string }) =>
  Effect.gen(function* () {
    const item = yield* query((d) =>
      d.select().from(workItems).where(eq(workItems.id, itemId)).get(),
    );
    if (!item) return { status: "failed" } satisfies UpdateOutcome;
    const all = yield* query((d) =>
      d
        .select()
        .from(workEvents)
        .where(
          and(
            eq(workEvents.workItemId, itemId),
            eq(workEvents.applied, false),
            inArray(workEvents.attachedBy, ["code", "model", "user", "answer"]),
          ),
        )
        .orderBy(asc(workEvents.at), asc(workEvents.id))
        .all(),
    );
    const quiet = all.filter((e) => TIMELINE_ONLY.has(e.kind as never));
    const markApplied = (ids: readonly string[]) =>
      ids.length
        ? query((d) =>
            d
              .update(workEvents)
              .set({ applied: true })
              .where(inArray(workEvents.id, [...ids])),
          )
        : Effect.void;
    yield* markApplied(quiet.map((e) => e.id));
    const rows = all
      .filter((e) => !TIMELINE_ONLY.has(e.kind as never))
      .slice(0, MAX_EVENTS_PER_CALL);
    if (rows.length === 0) return { status: "noop" } satisfies UpdateOutcome;

    const contactIds = [
      ...new Set(
        rows.flatMap((e) => [
          ...(eventData(e.data).contactIds ?? []),
          ...(e.actor.startsWith("contact:") ? [e.actor.slice(8)] : []),
        ]),
      ),
    ];
    const facts = yield* loadItemFacts(itemId, { today: opts.today, contactIds });
    const contacts = new Map(
      (yield* query((d) =>
        d.select({ id: people.id, name: people.displayName }).from(people).all(),
      )).map((p) => [p.id, p.name] as const),
    );
    const previous: WorkState | null = parseState(item.state);
    const earlierIds = [...new Set(previous?.commitments.map((c) => c.saidIn) ?? [])];
    const input: WorkStateInput = {
      name: item.name,
      keys: facts.tickets.map((t) => t.key),
      facts,
      previous,
      userNote: item.noteEditedAt && item.note ? item.note : null,
      earlier: earlierIds.map((id, i) => ({ id, label: `p${i + 1}` })),
      events: rows.map(
        (e, i): StateEvent => ({
          id: e.id,
          label: `e${i + 1}`,
          kind: e.kind as StateEvent["kind"],
          on: localDate(new Date(e.at)),
          actor: actorName(e.actor, contacts),
          summary: e.summary,
          text: eventText(e),
          ownWords: ownWords(e),
        }),
      ),
    };
    const llm = yield* Llm;
    const r = yield* Effect.either(
      llm.object<WorkStateOutput>("update_work_state", {
        schema: buildWorkStateSchema(input) as never,
        ...buildWorkStatePrompt(input),
        validate: (out) => validateWorkState(out, input),
      }),
    );
    const now = nowIso();
    if (Either.isLeft(r)) {
      if (r.left.kind !== "schema") {
        // A provider problem: nothing is lost, the events wait for the next pass.
        logger.warn(`Work state update for ${itemId} stopped`, r.left.message);
        return { status: "stopped", message: r.left.message } satisfies UpdateOutcome;
      }
      // Failed code's checks after repair: the previous state stays; the user should look.
      logger.warn(`Work state update for ${itemId} failed validation`, r.left.issues?.join("; "));
      yield* query((d) =>
        d
          .update(workItems)
          .set({ needsLook: true, stateUpdatedAt: now })
          .where(eq(workItems.id, itemId)),
      );
      yield* markApplied(rows.map((e) => e.id));
      return { status: "failed" } satisfies UpdateOutcome;
    }
    const out = r.right.value;
    const state = toWorkState(out, input);
    const goal = state.goal || null;
    yield* query((d) =>
      d
        .update(workItems)
        .set({
          state,
          goal,
          stateVersion: item.stateVersion + 1,
          stateUpdatedAt: now,
          needsLook: false,
          // The goal names the item until the user renames it (D61).
          ...(goal && item.nameBy !== "user"
            ? { name: goal.slice(0, 120), nameBy: "state" as const }
            : {}),
        })
        .where(eq(workItems.id, itemId)),
    );
    yield* markApplied(rows.map((e) => e.id));
    const question = out.question?.trim();
    return {
      status: "updated",
      question: question
        ? {
            itemId,
            question,
            choices: out.choices
              .map((c) => c.trim())
              .filter(Boolean)
              .slice(0, 5),
          }
        : null,
    } satisfies UpdateOutcome;
  });

/** Releases user notes whose named facts changed; the secretary's note shows again. */
const releaseNotes = (today: string) =>
  Effect.gen(function* () {
    const edited = yield* query((d) =>
      d
        .select()
        .from(workItems)
        .where(and(eq(workItems.status, "active"), isNotNull(workItems.noteEditedAt)))
        .all(),
    );
    for (const item of edited) {
      const facts = yield* loadItemFacts(item.id, { today });
      if (noteStillHolds(item.noteFacts, item.note ?? "", facts)) continue;
      yield* query((d) =>
        d
          .update(workItems)
          .set({ noteEditedAt: null, noteFacts: null })
          .where(eq(workItems.id, item.id)),
      );
      yield* appendEvents([
        {
          kind: "correction",
          actor: "sync",
          summary: "A fact your status note named changed, so the secretary's note is back",
          workItemId: item.id,
          attachedBy: "code",
          applied: true,
        },
      ]);
    }
  });

export const runWorkPass = (opts: { now?: Date } = {}) =>
  Effect.gen(function* () {
    const now = opts.now ?? new Date();
    const today = localDate(now);
    const settings = yield* settingsOrDefault(yield* Settings);
    const result: PassResult = {
      created: 0,
      attached: 0,
      calls: 0,
      failed: 0,
      deferred: 0,
      asked: 0,
      offered: 0,
      returned: 0,
    };
    if (!settings.work.enabled) {
      // Nothing is current while the work model is off: parked threads come back.
      result.returned = yield* returnParked(now);
      return { ...result, skipped: "disabled" } satisfies PassResult;
    }

    const grouping = yield* regroup(settings, now);
    result.created = grouping.created.length;
    // An item is current for the day it was set; parked threads come back
    // when it changes or closes (the grouping just closed what is done), or
    // on the first pass of the next day (D62).
    yield* settleCurrent(today);
    result.returned = yield* returnParked(now);
    yield* expireQuestions(now);
    const attach = yield* attachPending(now);
    result.attached = attach.attached;
    yield* releaseNotes(today);

    const meaning: MeaningAsk[] = [];
    const dayStart = dayStartIso(now);
    let left = settings.work.stateCallsPerDay - (yield* stateCallsSince(dayStart));
    const items = yield* itemsToUpdate;
    for (const item of items) {
      if (left <= 0) {
        result.deferred++;
        continue;
      }
      left--;
      const outcome = yield* updateItemState(item.id, { today });
      if (outcome.status === "noop") {
        left++;
        continue;
      }
      if (outcome.status === "stopped") {
        result.deferred += 1;
        break;
      }
      result.calls++;
      if (outcome.status === "failed") result.failed++;
      else if (outcome.question) meaning.push(outcome.question);
    }

    const asked = yield* askQuestions({
      attach: attach.asks,
      meaning,
      doubts: grouping.doubts,
      perDay: settings.work.questionsPerDay,
      dayStart,
    });
    result.asked = asked.length;
    result.offered = (yield* runOutcomes({ now, settings })).offered;
    if (result.calls || result.created || result.asked || result.offered || result.returned)
      logger.info(
        `Work pass: ${result.created} new items, ${result.attached} attached, ${result.calls} state updates, ${result.asked} questions, ${result.offered} outcome cards${result.returned ? `, ${result.returned} parked threads back` : ""}`,
      );
    return result;
  });

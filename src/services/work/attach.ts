/**
 * Attaching events to work items (FR-19.2, D61). Code first, by signals in
 * order: the ticket keys the event names; for an Inbox message, the tickets
 * its proposals act on, then the thread's other tickets; the wait it is about;
 * the open waits of the contacts it names (when only a person is named). The
 * first signal that reaches an item decides the candidates. One candidate
 * attaches; several go to `attach_event` when the event has words, and an
 * unsure answer, no words or a failed call make a question instead (FR-19.4):
 * the event waits unattached and nothing is guessed into the state.
 */
import { and, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { Effect, Either } from "effect";
import { dependencies, proposals, workEvents, workItemIssues, workItems } from "@/db/schema";
import {
  type AttachEventOutput,
  attachDecision,
  buildAttachEventPrompt,
  buildAttachEventSchema,
  validateAttachEvent,
} from "@/prompts/attach-event";
import { query } from "@/services/db";
import { Llm, TASK_DEFAULTS } from "@/services/llm";
import { effectivePayload, issueRefs } from "@/services/proposals/schema";
import { datesInText } from "./dates";
import {
  eventData,
  eventText,
  MessageDataSchema,
  parseState,
  TEXT_KINDS,
  TIMELINE_ONLY,
} from "./schema";

type EventRow = typeof workEvents.$inferSelect;

/** An event still unattached after this long belongs to none. */
const WAIT_DAYS = 7;
/** How far back an Inbox thread's other messages count as its signals. */
const THREAD_DAYS = 30;

export type Signals = {
  own: readonly string[];
  proposals: readonly string[];
  thread: readonly string[];
  wait: string | null;
  persons: readonly string[];
};

/** The candidate items from the first signal that reaches any (pure). */
export function candidateItems(
  s: Signals,
  itemOf: (key: string) => string | null,
): { by: keyof Signals | null; items: string[] } {
  const tiers: [keyof Signals, readonly string[]][] = [
    ["own", s.own],
    ["proposals", s.proposals],
    ["thread", s.thread],
    ["wait", s.wait ? [s.wait] : []],
    ["persons", s.persons],
  ];
  for (const [by, keys] of tiers) {
    const items = [...new Set(keys.map(itemOf).filter((x): x is string => !!x))];
    if (items.length) return { by, items: items.sort() };
  }
  return { by: null, items: [] };
}

/** An event code could not attach on its own: the question to ask about it. */
export type AttachAsk = {
  eventId: string;
  itemIds: string[];
  /** The Inbox thread the event came from: the question goes there, not rationed. */
  inboxItemId: string | null;
  /** Its words name a date: such a question is asked first. */
  datesNamed: boolean;
  summary: string;
  text: string;
};

const keysOfPayloads = (rows: readonly (typeof proposals.$inferSelect)[]) =>
  rows.flatMap((r) => {
    const made = (r.result as { issueKey?: string } | null)?.issueKey;
    return [...issueRefs(effectivePayload(r), { only: "keys" }), ...(made ? [made] : [])];
  });

/** Code's signals for each event, read in a few queries. */
const loadSignals = (events: readonly EventRow[], now: Date) =>
  Effect.gen(function* () {
    const threadSince = new Date(now.getTime() - THREAD_DAYS * 86_400_000).toISOString();
    const inboxIds = [
      ...new Set(
        events.flatMap((e) => {
          const id = eventData(e.data).inboxItemId;
          return e.kind === "message" && id ? [id] : [];
        }),
      ),
    ];
    const threadProposals = inboxIds.length
      ? yield* query((d) =>
          d
            .select()
            .from(proposals)
            .where(and(inArray(proposals.inboxItemId, inboxIds)))
            .all(),
        )
      : [];
    const threadEvents = inboxIds.length
      ? (yield* query((d) =>
          d
            .select()
            .from(workEvents)
            .where(and(eq(workEvents.kind, "message"), gte(workEvents.at, threadSince)))
            .all(),
        )).filter((e) => inboxIds.includes(eventData(e.data).inboxItemId ?? ""))
      : [];
    const deps = yield* query((d) =>
      d
        .select({
          id: dependencies.id,
          issueKey: dependencies.issueKey,
          owner: dependencies.ownerPersonId,
          status: dependencies.status,
        })
        .from(dependencies)
        .all(),
    );
    const depKey = new Map(deps.map((x) => [x.id, x.issueKey]));
    const openByOwner = new Map<string, string[]>();
    for (const x of deps)
      if (x.owner && x.status !== "resolved")
        openByOwner.set(x.owner, [...(openByOwner.get(x.owner) ?? []), x.issueKey]);
    const live = (rows: typeof threadProposals) =>
      rows.filter((r) => !["rejected", "superseded", "revoked"].includes(r.status));

    return (e: EventRow): Signals => {
      const d = eventData(e.data);
      const m = e.kind === "message" ? MessageDataSchema.safeParse(e.data) : null;
      const msg = m?.success ? m.data : null;
      const own = [...(e.issueKey ? [e.issueKey] : []), ...(d.keys ?? [])];
      const mine = msg
        ? keysOfPayloads(live(threadProposals.filter((p) => p.intakeItemId === msg.intakeItemId)))
        : [];
      const thread = msg
        ? [
            ...keysOfPayloads(
              live(threadProposals.filter((p) => p.inboxItemId === msg.inboxItemId)),
            ),
            ...threadEvents
              .filter((t) => t.id !== e.id && eventData(t.data).inboxItemId === msg.inboxItemId)
              .flatMap((t) => eventData(t.data).keys ?? []),
          ]
        : [];
      const wait = d.dependencyId ? (depKey.get(d.dependencyId) ?? null) : null;
      // A person counts when the event names no ticket at all.
      const persons =
        own.length === 0 ? (d.contactIds ?? []).flatMap((id) => openByOwner.get(id) ?? []) : [];
      return { own, proposals: mine, thread, wait, persons };
    };
  });

/** One-line state of an item for the attach prompt. */
const stateLine = (state: unknown) => {
  const s = parseState(state);
  if (!s) return null;
  return [s.goal, s.currentStep].filter(Boolean).join(" Now: ") || null;
};

/** Attaches waiting events; returns how many attached and the questions to ask. */
export const attachPending = (now = new Date()) =>
  Effect.gen(function* () {
    const since = new Date(now.getTime() - WAIT_DAYS * 86_400_000).toISOString();
    // Every event left waiting this long belongs to none, whatever kept it (no
    // signal, or a question that never got a slot); one with a question out is
    // settled when its question expires.
    const old = yield* query((d) =>
      d
        .update(workEvents)
        .set({ attachedBy: "none", applied: true })
        .where(
          and(
            isNull(workEvents.attachedBy),
            lt(workEvents.at, since),
            sql`json_extract(${workEvents.data}, '$.question') IS NULL`,
          ),
        )
        .returning({ id: workEvents.id }),
    );
    const pending = yield* query((d) =>
      d
        .select()
        .from(workEvents)
        .where(and(isNull(workEvents.attachedBy), gte(workEvents.at, since)))
        .orderBy(workEvents.at)
        .all(),
    );
    const waiting = pending.filter((e) => !eventData(e.data).question);
    if (waiting.length === 0) return { attached: 0, settled: old.length, asks: [] as AttachAsk[] };
    const membership = new Map(
      (yield* query((d) =>
        d
          .select({
            key: workItemIssues.issueKey,
            id: workItemIssues.workItemId,
            status: workItems.status,
          })
          .from(workItemIssues)
          .innerJoin(workItems, eq(workItems.id, workItemIssues.workItemId))
          .all(),
      ))
        .filter((r) => r.status !== "dismissed")
        .map((r) => [r.key, r.id]),
    );
    const signalsOf = yield* loadSignals(waiting, now);
    const llm = yield* Llm;
    const items = new Map(
      (yield* query((d) => d.select().from(workItems).all())).map((i) => [i.id, i]),
    );
    const ticketsOf = (id: string) => [...membership].filter(([, v]) => v === id).map(([k]) => k);

    const set = (e: EventRow, patch: Partial<typeof workEvents.$inferInsert>) =>
      query((d) => d.update(workEvents).set(patch).where(eq(workEvents.id, e.id)));
    let attached = 0;
    let settled = old.length;
    const asks: AttachAsk[] = [];
    for (const e of waiting) {
      const { items: candidates } = candidateItems(signalsOf(e), (k) => membership.get(k) ?? null);
      const timelineOnly = TIMELINE_ONLY.has(e.kind as never);
      if (candidates.length === 1) {
        yield* set(e, { workItemId: candidates[0], attachedBy: "code", applied: timelineOnly });
        attached++;
        continue;
      }
      if (candidates.length === 0) continue;
      // Several items: a view or a correction never needs asking about.
      if (timelineOnly) {
        yield* set(e, { attachedBy: "none", applied: true });
        settled++;
        continue;
      }
      const text = eventText(e);
      const data = eventData(e.data);
      const ask: AttachAsk = {
        eventId: e.id,
        itemIds: candidates,
        inboxItemId: e.kind === "message" ? (data.inboxItemId ?? null) : null,
        datesNamed: datesInText(text, e.at.slice(0, 10)).length > 0,
        summary: e.summary,
        text,
      };
      if (!text.trim() || !TEXT_KINDS.has(e.kind as never) || data.attachTried) {
        asks.push(ask);
        continue;
      }
      const msg = MessageDataSchema.safeParse(e.data);
      const input = {
        summary: e.summary,
        text,
        ownWords: e.kind === "note" || (msg.success && msg.data.ownWords),
        candidates: candidates.map((id) => ({
          name: items.get(id)?.name ?? "Work item",
          tickets: ticketsOf(id),
          state: stateLine(items.get(id)?.state),
        })),
      };
      const r = yield* Effect.either(
        llm.object<AttachEventOutput>("attach_event", {
          schema: buildAttachEventSchema(candidates.length) as never,
          ...buildAttachEventPrompt(input),
          validate: (out) => validateAttachEvent(out, candidates.length),
          confidence: (out) => out.confidence,
        }),
      );
      const decision = Either.isRight(r)
        ? attachDecision(
            r.right.value,
            candidates.length,
            TASK_DEFAULTS.attach_event.confidenceThreshold,
          )
        : "unsure";
      if (typeof decision === "number") {
        yield* set(e, { workItemId: candidates[decision], attachedBy: "model" });
        attached++;
      } else if (decision === "new") {
        yield* set(e, { attachedBy: "none", applied: true });
        settled++;
      } else {
        // Not asked again of the model: the next passes go straight to the question.
        yield* set(e, { data: { ...data, attachTried: "unsure" } });
        asks.push(ask);
      }
    }
    return { attached, settled, asks };
  });

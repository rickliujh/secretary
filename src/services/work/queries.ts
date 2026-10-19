/**
 * Work items in the database (D61): the grouping run (load, `groupWork`,
 * apply), reads for the Work tab and Today, and the user's own changes:
 * rename, split, merge, move a ticket, edit the note, the current item, a note.
 * These are local writes like pin and snooze (D17); none touches Jira. Each
 * change the user makes to the grouping is a correction (a `memories` example,
 * subject `work_item`) that later runs respect, and an event on the timeline.
 */
import { and, desc, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { Effect } from "effect";
import {
  inboxItems,
  issueMeta,
  jiraIssues,
  memories,
  proposals,
  workEvents,
  workItemIssues,
  workItems,
} from "@/db/schema";
import { localDate } from "@/lib/dates";
import { newId, nowIso } from "@/lib/ids";
import { parseBlockers } from "@/services/blockers/logic";
import { query } from "@/services/db";
import { listDependencies } from "@/services/dependencies/queries";
import { parseIssueLinks } from "@/services/jira/schemas";
import type { AppSettings } from "@/services/settings/schema";
import { deletedKeys } from "@/services/sync/deleted";
import { getState, parseSprintState, SYNC_KEYS } from "@/services/sync/state";
import { appendEvents, eventsOfItems } from "./events";
import { loadItemFacts } from "./facts";
import {
  type Corrections,
  type GroupInput,
  type GroupResult,
  groupWork,
  type Member,
} from "./grouping";
import { derivedNote, noteFacts } from "./note";
import { quietOfItem } from "./outcomes";
import {
  type Correction,
  CorrectionSchema,
  eventData,
  parseState,
  TIMELINE_ONLY,
  WorkQuestionSchema,
} from "./schema";

/** Tickets a proposal or the user acted on this recently are active (D61). */
const ACTED_DAYS = 30;

/** The grouping corrections the user made, from `memories`. */
export const loadCorrections = Effect.map(
  query((d) =>
    d
      .select({ after: memories.exampleAfter })
      .from(memories)
      .where(eq(memories.subjectType, "work_item"))
      .all(),
  ),
  (rows): Corrections => {
    const together: string[][] = [];
    const apart: { keys: string[]; from: string[] }[] = [];
    for (const r of rows) {
      const c = CorrectionSchema.safeParse(r.after);
      if (!c.success) continue;
      if (c.data.type === "together") together.push(c.data.keys);
      if (c.data.type === "apart") apart.push({ keys: c.data.keys, from: c.data.from });
    }
    return { together, apart };
  },
);

/** Everything `groupWork` reads, from one snapshot of the cache. */
export const loadGroupInput = (settings: AppSettings, now = new Date()) =>
  Effect.gen(function* () {
    const me = (yield* getState(SYNC_KEYS.username)) ?? null;
    const sprints = parseSprintState(yield* getState(SYNC_KEYS.sprints)).sprints;
    const rows = yield* query((d) =>
      d
        .select({
          key: jiraIssues.key,
          summary: jiraIssues.summary,
          issueType: jiraIssues.issueType,
          isSubtask: jiraIssues.isSubtask,
          statusCategory: jiraIssues.statusCategory,
          assignee: jiraIssues.assignee,
          parentKey: jiraIssues.parentKey,
          epicKey: jiraIssues.epicKey,
          epicName: jiraIssues.epicName,
          sprint: jiraIssues.sprint,
          labels: jiraIssues.labels,
          links: sql<string | null>`json_extract(${jiraIssues.raw}, '$.issuelinks')`,
          requesterId: issueMeta.requesterPersonId,
          stale: jiraIssues.stale,
        })
        .from(jiraIssues)
        .leftJoin(issueMeta, eq(issueMeta.issueKey, jiraIssues.key))
        .all(),
    );
    const epicSummary = new Map(rows.map((r) => [r.key, r.summary]));
    const since = new Date(now.getTime() - ACTED_DAYS * 86_400_000).toISOString();
    const recent = yield* query((d) =>
      d
        .select({ kind: workEvents.kind, issueKey: workEvents.issueKey, data: workEvents.data })
        .from(workEvents)
        .where(
          and(
            gte(workEvents.at, since),
            inArray(workEvents.kind, ["proposal_executed", "ticket_edited", "message"]),
          ),
        )
        .all(),
    );
    const actedOn = new Set<string>();
    const namedTogether: string[][] = [];
    for (const e of recent) {
      const keys = eventData(e.data).keys ?? [];
      if (e.kind === "message") {
        if (keys.length >= 2) namedTogether.push(keys);
        continue;
      }
      if (e.issueKey) actedOn.add(e.issueKey);
      if (e.kind === "proposal_executed") for (const k of keys) actedOn.add(k);
    }
    const waits = (yield* listDependencies()).map((w) => ({
      issueKey: w.issueKey,
      owner: w.ownerPersonId
        ? `person:${w.ownerPersonId}`
        : w.ownerTeamId
          ? `team:${w.ownerTeamId}`
          : null,
    }));
    const memberRows = yield* query((d) => d.select().from(workItemIssues).all());
    const members = new Map<string, Member>(
      memberRows.map((m) => [
        m.issueKey,
        { itemId: m.workItemId, role: m.role, addedBy: m.addedBy },
      ]),
    );
    const activeItems = new Set(
      (yield* query((d) =>
        d.select({ id: workItems.id }).from(workItems).where(eq(workItems.status, "active")).all(),
      )).map((r) => r.id),
    );
    const home = settings.smallAsks;
    return {
      me,
      activeSprints: new Set(sprints.filter((s) => s.state === "active").map((s) => s.name)),
      smallAskLabel: home.projectKey && home.label.trim() ? home.label.trim() : null,
      tickets: rows.map((r) => ({
        key: r.key,
        summary: r.summary,
        issueType: r.issueType,
        isSubtask: !!r.isSubtask,
        statusCategory: r.statusCategory,
        assignee: r.assignee,
        parentKey: r.parentKey,
        epicKey: r.epicKey,
        epicName: r.epicName ?? (r.epicKey ? (epicSummary.get(r.epicKey) ?? null) : null),
        sprint: r.sprint,
        labels: r.labels ?? [],
        links: parseIssueLinks(r.links),
        requesterId: r.requesterId ?? null,
        stale: !!r.stale,
      })),
      actedOn,
      namedTogether,
      waits,
      blockers: parseBlockers(yield* getState(SYNC_KEYS.blockers)),
      members,
      activeItems,
      corrections: yield* loadCorrections,
      cap: settings.work.groupSizeCap,
    } satisfies GroupInput;
  });

export type DoubtOfItems = { reason: "cap" | "items"; itemIds: [string, string] };

export type GroupingApplied = {
  created: string[];
  joined: number;
  closed: string[];
  reopened: string[];
  doubts: DoubtOfItems[];
};

/** Writes a grouping result and closes or reopens items by their tickets' status. */
export const applyGrouping = (result: GroupResult, input: GroupInput, now = nowIso()) =>
  Effect.gen(function* () {
    const created: string[] = [];
    for (const g of result.created) {
      const id = newId();
      created.push(id);
      yield* query((d) =>
        d.insert(workItems).values({ id, name: g.name.slice(0, 200), createdAt: now }),
      );
      yield* query((d) =>
        d
          .insert(workItemIssues)
          .values(
            g.keys.map((k) => ({ issueKey: k.key, workItemId: id, role: k.role, addedAt: now })),
          )
          .onConflictDoNothing(),
      );
    }
    if (result.joins.length)
      yield* query((d) =>
        d
          .insert(workItemIssues)
          .values(
            result.joins.map((j) => ({
              issueKey: j.key,
              workItemId: j.itemId,
              role: j.role,
              addedAt: now,
            })),
          )
          .onConflictDoNothing(),
      );
    // A related ticket that became the user's own is primary from now on.
    const promote = [...input.members]
      .filter(([k, m]) => m.role === "related" && result.active.has(k))
      .map(([k]) => k);
    if (promote.length)
      yield* query((d) =>
        d
          .update(workItemIssues)
          .set({ role: "primary" })
          .where(inArray(workItemIssues.issueKey, promote)),
      );

    // Close an item whose own tickets are all done (or deleted); reopen one with an open, active ticket.
    const status = new Map(input.tickets.map((t) => [t.key, t.statusCategory]));
    const deleted = yield* deletedKeys;
    const items = yield* query((d) =>
      d.select().from(workItems).where(ne(workItems.status, "dismissed")).all(),
    );
    const members = yield* query((d) => d.select().from(workItemIssues).all());
    const byItem = new Map<string, typeof members>();
    for (const m of members) byItem.set(m.workItemId, [...(byItem.get(m.workItemId) ?? []), m]);
    const closed: string[] = [];
    const reopened: string[] = [];
    for (const item of items) {
      const own = (byItem.get(item.id) ?? []).filter((m) => m.role === "primary");
      if (item.status === "active") {
        // No ticket of the user's left (only tickets it waited on, or none): the item
        // is dismissed and lets go of them, so they can join the work they belong to.
        if (own.length === 0) {
          yield* query((d) =>
            d.delete(workItemIssues).where(eq(workItemIssues.workItemId, item.id)),
          );
          yield* query((d) =>
            d
              .update(workItems)
              .set({ status: "dismissed", closedAt: now, current: false })
              .where(eq(workItems.id, item.id)),
          );
          continue;
        }
        const done =
          own.length > 0 &&
          own.every((m) => deleted.has(m.issueKey) || status.get(m.issueKey) === "done");
        if (done) {
          closed.push(item.id);
          yield* query((d) =>
            d
              .update(workItems)
              .set({ status: "done", closedAt: now, current: false })
              .where(eq(workItems.id, item.id)),
          );
        }
      } else if (item.status === "done" && own.some((m) => result.active.has(m.issueKey))) {
        reopened.push(item.id);
        yield* query((d) =>
          d
            .update(workItems)
            .set({ status: "active", closedAt: null })
            .where(eq(workItems.id, item.id)),
        );
      }
    }

    const itemOfKey = new Map(
      (yield* query((d) => d.select().from(workItemIssues).all())).map((m) => [
        m.issueKey,
        m.workItemId,
      ]),
    );
    const doubts: DoubtOfItems[] = [];
    for (const dbt of result.doubts) {
      const a = itemOfKey.get(dbt.a);
      const b = itemOfKey.get(dbt.b);
      if (a && b && a !== b)
        doubts.push({ reason: dbt.reason, itemIds: [a, b].sort() as [string, string] });
    }
    return {
      created,
      joined: result.joins.length,
      closed,
      reopened,
      doubts,
    } satisfies GroupingApplied;
  });

/** One grouping run: after a sync, and before each pass attaches events. */
export const regroup = (settings: AppSettings, now = new Date()) =>
  Effect.gen(function* () {
    const input = yield* loadGroupInput(settings, now);
    return yield* applyGrouping(groupWork(input), input, now.toISOString());
  });

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type WorkRef = { id: string; name: string; current: boolean };

/** Active items by ticket key, for Today and the ticket table. */
export const workByIssue = Effect.map(
  query((d) =>
    d
      .select({
        key: workItemIssues.issueKey,
        id: workItems.id,
        name: workItems.name,
        current: workItems.current,
      })
      .from(workItemIssues)
      .innerJoin(workItems, eq(workItems.id, workItemIssues.workItemId))
      .where(eq(workItems.status, "active"))
      .all(),
  ),
  (rows) =>
    new Map(rows.map((r) => [r.key, { id: r.id, name: r.name, current: !!r.current }] as const)),
);

export const listActiveItems = query((d) =>
  d
    .select({ id: workItems.id, name: workItems.name, current: workItems.current })
    .from(workItems)
    .where(eq(workItems.status, "active"))
    .orderBy(desc(workItems.current), workItems.name)
    .all(),
);

const itemRow = (id: string) =>
  query((d) => d.select().from(workItems).where(eq(workItems.id, id)).get());

/** The Work tab: the item a ticket belongs to, its note, tickets, facts and timeline. */
export const workItemDetail = (issueKey: string, today = localDate()) =>
  Effect.gen(function* () {
    const member = yield* query((d) =>
      d.select().from(workItemIssues).where(eq(workItemIssues.issueKey, issueKey)).get(),
    );
    if (!member) return null;
    const item = yield* itemRow(member.workItemId);
    if (!item) return null;
    const facts = yield* loadItemFacts(item.id, { today });
    const state = parseState(item.state);
    const names = new Map(facts.people.map((p) => [p.id, p.name]));
    const derived = derivedNote(state, facts, names);
    const timeline = yield* eventsOfItems([item.id], 100);
    const thread = yield* query((d) =>
      d
        .select({ id: inboxItems.id })
        .from(inboxItems)
        .where(and(eq(inboxItems.workItemId, item.id), ne(inboxItems.source, "secretary")))
        .get(),
    );
    const others = (yield* listActiveItems).filter((o) => o.id !== item.id);
    const quiet = [...(yield* quietOfItem(item.id))];
    return {
      item: {
        id: item.id,
        name: item.name,
        status: item.status,
        current: item.current,
        needsLook: item.needsLook,
        stateUpdatedAt: item.stateUpdatedAt,
        noteEdited: !!item.noteEditedAt,
      },
      state,
      note: item.noteEditedAt && item.note ? item.note : derived,
      derivedNote: derived,
      facts,
      people: names,
      timeline,
      threadId: thread?.id ?? null,
      others,
      /** Rules dismissed twice here (Phase 25), offered again from the item menu. */
      quiet,
    };
  });
export type WorkItemDetail = NonNullable<Effect.Effect.Success<ReturnType<typeof workItemDetail>>>;

// ---------------------------------------------------------------------------
// The user's changes (local writes, D17)
// ---------------------------------------------------------------------------

const keysOf = (itemId: string) =>
  Effect.map(
    query((d) =>
      d
        .select({ key: workItemIssues.issueKey })
        .from(workItemIssues)
        .where(eq(workItemIssues.workItemId, itemId))
        .all(),
    ),
    (rows) => rows.map((r) => r.key),
  );

/** A correction the grouping respects from now on, kept as a confirmed example memory. */
export const recordCorrection = (
  itemId: string,
  correction: Correction,
  content: string,
  source: "user" | "answer" = "user",
) =>
  query((d) =>
    d.insert(memories).values({
      id: newId(),
      kind: "example",
      subjectType: "work_item",
      subjectId: itemId,
      content,
      exampleInput: source === "answer" ? "Answer to a work question" : null,
      exampleBefore: null,
      exampleAfter: correction,
      source: "user",
      confirmed: true,
      createdAt: nowIso(),
    }),
  );

const correctionEvent = (itemId: string, summary: string) =>
  appendEvents([
    {
      kind: "correction",
      actor: "me",
      summary,
      workItemId: itemId,
      attachedBy: "user",
      applied: true,
    },
  ]);

export const renameItem = (id: string, name: string) =>
  Effect.gen(function* () {
    const item = yield* itemRow(id);
    const next = name.trim().slice(0, 200);
    if (!item || !next || next === item.name) return;
    yield* query((d) =>
      d.update(workItems).set({ name: next, nameBy: "user" }).where(eq(workItems.id, id)),
    );
    yield* recordCorrection(
      id,
      { type: "rename", name: next },
      `Renamed "${item.name}" to "${next}"`,
    );
    yield* correctionEvent(id, `Renamed to "${next}" (was "${item.name}")`);
  });

/** Moves tickets of an item into a new item, or into another one; they stay apart from the rest. */
const moveKeys = (
  fromId: string,
  keys: readonly string[],
  to: { itemId: string } | { name: string },
  addedBy: "user" | "answer" = "user",
) =>
  Effect.gen(function* () {
    const now = nowIso();
    // The user's statement is about their own tickets: one the old item waits on
    // (a blocker) is not kept apart from what moved.
    const rest = (yield* query((d) =>
      d
        .select({ key: workItemIssues.issueKey })
        .from(workItemIssues)
        .where(and(eq(workItemIssues.workItemId, fromId), eq(workItemIssues.role, "primary")))
        .all(),
    ))
      .map((m) => m.key)
      .filter((k) => !keys.includes(k));
    let target: string;
    if ("itemId" in to) target = to.itemId;
    else {
      target = newId();
      yield* query((d) =>
        d.insert(workItems).values({ id: target, name: to.name.slice(0, 200), createdAt: now }),
      );
    }
    yield* query((d) =>
      d
        .update(workItemIssues)
        .set({ workItemId: target, addedBy, addedAt: now })
        .where(inArray(workItemIssues.issueKey, [...keys])),
    );
    if (rest.length)
      yield* recordCorrection(
        target,
        { type: "apart", keys: [...keys], from: rest },
        `${keys.join(", ")} is separate from ${rest.join(", ")}`,
        addedBy,
      );
    else {
      // None of the user's tickets left: dismissed, and what it waited on is let go.
      yield* query((d) => d.delete(workItemIssues).where(eq(workItemIssues.workItemId, fromId)));
      yield* query((d) =>
        d
          .update(workItems)
          .set({ status: "dismissed", closedAt: now, current: false })
          .where(eq(workItems.id, fromId)),
      );
    }
    return target;
  });

/** Splits tickets off an item into a new item named after the first of them. */
export const splitItem = (id: string, keys: readonly string[]) =>
  Effect.gen(function* () {
    const own = yield* keysOf(id);
    const moving = keys.filter((k) => own.includes(k));
    if (moving.length === 0 || moving.length === own.length) return null;
    // A new item needs a ticket of the user's: one it waits on stays with its blocked ticket (D61).
    const primary = (yield* query((d) =>
      d
        .select({ key: workItemIssues.issueKey })
        .from(workItemIssues)
        .where(and(eq(workItemIssues.workItemId, id), eq(workItemIssues.role, "primary")))
        .all(),
    )).map((m) => m.key);
    if (!moving.some((k) => primary.includes(k))) return null;
    const first = yield* query((d) =>
      d
        .select({ summary: jiraIssues.summary })
        .from(jiraIssues)
        .where(eq(jiraIssues.key, moving[0] ?? ""))
        .get(),
    );
    const target = yield* moveKeys(id, moving, {
      name: first?.summary ?? moving[0] ?? "Work item",
    });
    yield* correctionEvent(id, `Split ${moving.join(", ")} off into a new item`);
    yield* correctionEvent(target, `Split off from another item: ${moving.join(", ")}`);
    return target;
  });

/** Moves one ticket to another item, or to a new item of its own (`to` null). */
export const moveTicket = (issueKey: string, to: string | null) =>
  Effect.gen(function* () {
    const member = yield* query((d) =>
      d.select().from(workItemIssues).where(eq(workItemIssues.issueKey, issueKey)).get(),
    );
    if (!member || member.workItemId === to) return null;
    // A ticket the item waits on moves only into another item, never into one of its own (D61).
    if (!to && member.role === "related") return null;
    const summary = (yield* query((d) =>
      d
        .select({ summary: jiraIssues.summary })
        .from(jiraIssues)
        .where(eq(jiraIssues.key, issueKey))
        .get(),
    ))?.summary;
    const target = yield* moveKeys(
      member.workItemId,
      [issueKey],
      to ? { itemId: to } : { name: summary ?? issueKey },
    );
    yield* correctionEvent(member.workItemId, `Moved ${issueKey} to another item`);
    yield* correctionEvent(target, `${issueKey} moved here`);
    return target;
  });

/** Merges `fromId` into `intoId`: its tickets and timeline move, it is dismissed. */
/**
 * Pending work questions about `fromId` are about `intoId` from now on; one
 * that asked whether the two are one piece of work is settled by the merge.
 */
const repointQuestions = (fromId: string, intoId: string) =>
  Effect.gen(function* () {
    const pending = yield* query((d) =>
      d
        .select()
        .from(proposals)
        .where(
          and(
            eq(proposals.kind, "needs_clarification"),
            eq(proposals.status, "pending"),
            sql`json_extract(${proposals.payload}, '$.work.type') IS NOT NULL`,
          ),
        )
        .all(),
    );
    for (const row of pending) {
      const payload = row.payload as { work?: unknown } & Record<string, unknown>;
      const q = WorkQuestionSchema.safeParse(payload.work);
      if (!q.success) continue;
      const swap = (id: string) => (id === fromId ? intoId : id);
      const work = q.data;
      if (work.type === "meaning") {
        if (work.itemId !== fromId) continue;
        yield* query((d) =>
          d
            .update(proposals)
            .set({ payload: { ...payload, work: { ...work, itemId: intoId } } })
            .where(eq(proposals.id, row.id)),
        );
        continue;
      }
      if (!work.itemIds.includes(fromId)) continue;
      const itemIds = [...new Set(work.itemIds.map(swap))];
      if (work.type === "group" || itemIds.length < 2) {
        // The merge answered it (a group question), or one item is left to choose.
        yield* query((d) =>
          d
            .update(proposals)
            .set({ status: "rejected", decidedAt: nowIso(), result: { merged: true } })
            .where(eq(proposals.id, row.id)),
        );
        if (work.type === "attach")
          yield* query((d) =>
            d
              .update(workEvents)
              .set({ workItemId: intoId, attachedBy: "answer", applied: false })
              .where(and(eq(workEvents.id, work.eventId), sql`${workEvents.attachedBy} IS NULL`)),
          );
        continue;
      }
      yield* query((d) =>
        d
          .update(proposals)
          .set({ payload: { ...payload, work: { ...work, itemIds } } })
          .where(eq(proposals.id, row.id)),
      );
    }
  });

export const mergeItems = (fromId: string, intoId: string, by: "user" | "answer" = "user") =>
  Effect.gen(function* () {
    if (fromId === intoId) return;
    const from = yield* itemRow(fromId);
    const into = yield* itemRow(intoId);
    if (!from || !into) return;
    const keys = [...(yield* keysOf(intoId)), ...(yield* keysOf(fromId))];
    const now = nowIso();
    yield* query((d) =>
      d
        .update(workItemIssues)
        .set({ workItemId: intoId, addedBy: by, addedAt: now })
        .where(eq(workItemIssues.workItemId, fromId)),
    );
    // Its timeline moves too, and is folded into the survivor's state on the next
    // pass, so what the merged item knew (its commitments) is not lost. The
    // survivor's own note and state stay.
    const refold = (yield* eventsOfItems([fromId], 100_000))
      .filter(
        (e) =>
          !TIMELINE_ONLY.has(e.kind as never) &&
          ["code", "model", "user", "answer"].includes(e.attachedBy ?? ""),
      )
      .map((e) => e.id);
    yield* query((d) =>
      d.update(workEvents).set({ workItemId: intoId }).where(eq(workEvents.workItemId, fromId)),
    );
    for (let i = 0; i < refold.length; i += 500)
      yield* query((d) =>
        d
          .update(workEvents)
          .set({ applied: false })
          .where(inArray(workEvents.id, refold.slice(i, i + 500))),
      );
    // Its questions and its thread now belong to the survivor.
    yield* query((d) =>
      d.update(inboxItems).set({ workItemId: intoId }).where(eq(inboxItems.workItemId, fromId)),
    );
    yield* repointQuestions(fromId, intoId);
    yield* query((d) =>
      d
        .update(workItems)
        .set({ status: "dismissed", mergedInto: intoId, closedAt: now, current: false })
        .where(eq(workItems.id, fromId)),
    );
    if (from.current) yield* setCurrent(intoId);
    if (keys.length >= 2)
      yield* recordCorrection(
        intoId,
        { type: "together", keys },
        `"${from.name}" and "${into.name}" are one piece of work`,
        by,
      );
    yield* correctionEvent(intoId, `Merged "${from.name}" into this item`);
  });

/** The item the user is on: at most one; null clears it. */
export const setCurrent = (id: string | null) =>
  Effect.gen(function* () {
    yield* query((d) =>
      d.update(workItems).set({ current: false }).where(eq(workItems.current, true)),
    );
    if (id)
      yield* query((d) => d.update(workItems).set({ current: true }).where(eq(workItems.id, id)));
  });

/**
 * The user's own status note (FR-19.3): kept word for word until a fact it
 * names changes, and recorded as a correction. Empty text goes back to the
 * secretary's note.
 */
export const editNote = (id: string, text: string, today = localDate()) =>
  Effect.gen(function* () {
    const item = yield* itemRow(id);
    if (!item) return;
    const note = text.trim();
    const facts = yield* loadItemFacts(id, { today });
    const before =
      item.noteEditedAt && item.note ? item.note : derivedNote(parseState(item.state), facts);
    if (!note) {
      yield* query((d) =>
        d
          .update(workItems)
          .set({ note: null, noteEditedAt: null, noteFacts: null })
          .where(eq(workItems.id, id)),
      );
      return;
    }
    if (note === before) return;
    yield* query((d) =>
      d
        .update(workItems)
        .set({ note, noteEditedAt: nowIso(), noteFacts: noteFacts(note, facts) })
        .where(eq(workItems.id, id)),
    );
    yield* recordCorrection(
      id,
      { type: "note", note, before },
      `Status note: "${note.slice(0, 200)}"`,
    );
    yield* correctionEvent(id, "Edited the status note");
  });

/** A note from the user ("I'm on the cert now"): an event the next state update reads. */
export const addNote = (id: string, text: string) =>
  Effect.gen(function* () {
    const note = text.trim();
    if (!note) return;
    yield* appendEvents([
      {
        kind: "note",
        actor: "me",
        summary: note.slice(0, 200),
        data: { text: note.slice(0, 4000) },
        workItemId: id,
        attachedBy: "user",
      },
    ]);
  });

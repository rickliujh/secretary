/**
 * Outcome cards (FR-19.6, Phase 25) over the in-memory Db: a situation becomes
 * one card with its steps as one bundle in order; the same situation is offered
 * once whatever became of it; at most five a pass, the current item first and
 * then by the rules' order; what the rules saw is remembered, so a moved date
 * counts once, and the first run reads no old news.
 */
import { describe, expect, test } from "bun:test";
import { and, asc, eq, ne } from "drizzle-orm";
import { Effect } from "effect";
import {
  dependencies,
  inboxItems,
  jiraIssues,
  proposals,
  teams,
  workEvents,
  workItemIssues,
  workItems,
} from "@/db/schema";
import { localDate } from "@/lib/dates";
import { nowIso } from "@/lib/ids";
import { query } from "@/services/db";
import { type AppSettings, defaultSettings } from "@/services/settings/schema";
import { insertIssues, issue, seedSyncState, workTestLayer } from "@/test/work";
import { appendEvents } from "./events";
import { OUTCOMES_PER_PASS, pendingOutcomes, runOutcomes } from "./outcomes";
import { situationOf, type WorkState } from "./schema";

const NOW = new Date();
const DAY = 86_400_000;
const day = (n: number) => localDate(new Date(NOW.getTime() + n * DAY));

const state = (on: string | null): WorkState => ({
  goal: "",
  currentStep: "",
  nextExpected: on ? { what: "Platform issues the cert", on } : null,
  commitments: [],
  openQuestions: [],
  people: [],
});

/** A work item with its tickets (cached, the user's) and an optional state. */
const seedItem = (
  id: string,
  keys: string[],
  opts: { current?: boolean; state?: WorkState; at?: string } = {},
) =>
  Effect.gen(function* () {
    yield* insertIssues(keys.map((k) => issue(k)));
    yield* query((d) =>
      d.insert(workItems).values({
        id,
        name: `Item ${id}`,
        current: opts.current ?? false,
        state: opts.state ?? null,
        createdAt: opts.at ?? nowIso(),
      }),
    );
    yield* query((d) =>
      d.insert(workItemIssues).values(
        keys.map((k) => ({
          workItemId: id,
          issueKey: k,
          role: "primary" as const,
          addedAt: nowIso(),
        })),
      ),
    );
  });

const seedWait = (id: string, issueKey: string, p: Partial<typeof dependencies.$inferInsert>) =>
  query((d) =>
    d.insert(dependencies).values({
      id,
      issueKey,
      kind: "team",
      label: `the thing on ${issueKey}`,
      ownerTeamId: "t-platform",
      status: "waiting",
      requestedAt: new Date(NOW.getTime() - 10 * DAY).toISOString(),
      ...p,
    }),
  );

const seedBase = Effect.gen(function* () {
  yield* seedSyncState;
  yield* query((d) => d.insert(teams).values({ id: "t-platform", name: "Platform" }));
});

const cards = query((d) =>
  d
    .select()
    .from(inboxItems)
    .where(eq(inboxItems.source, "secretary"))
    .orderBy(asc(inboxItems.receivedAt))
    .all(),
);
const offeredEvents = query((d) =>
  d
    .select()
    .from(workEvents)
    .where(eq(workEvents.kind, "outcome_offered"))
    .orderBy(asc(workEvents.id))
    .all(),
);

const run = (settings: AppSettings = defaultSettings()) => runOutcomes({ now: NOW, settings });

describe("runOutcomes", () => {
  test("a situation becomes one card: the inbox item, its steps as one bundle, the event", async () => {
    const { run: go } = workTestLayer();
    const r = await go(
      Effect.gen(function* () {
        yield* seedBase;
        // The first run ever only remembers; this one has nothing to remember.
        yield* run();
        yield* seedItem("w1", ["PAY-12"]);
        yield* seedWait("d1", "PAY-12", { nextFollowupAt: day(-1) });
        const result = yield* run();
        const [card] = yield* cards;
        const steps = yield* query((d) =>
          d
            .select()
            .from(proposals)
            .where(eq(proposals.inboxItemId, card?.id ?? ""))
            .orderBy(asc(proposals.seq))
            .all(),
        );
        return { result, card, steps, events: yield* offeredEvents, open: yield* pendingOutcomes };
      }),
    );
    expect(r.result.offered).toBe(1);
    expect(r.card).toMatchObject({
      source: "secretary",
      status: "triaged",
      workItemId: "w1",
      summary: "Chase Platform: the thing on PAY-12",
    });
    expect(r.card?.situationKey).toMatch(/^wait_unanswered:w1:[0-9a-f]{8}$/);
    expect(r.card?.rawText).toContain("Chase Platform");
    const record = situationOf(r.card?.triage);
    expect(record?.rule).toBe("wait_unanswered");
    expect(record?.keys).toEqual(["PAY-12"]);
    expect(record?.steps).toEqual([
      { seq: 0, label: "Draft a chase to Platform", required: true },
      { seq: 1, label: expect.stringContaining("Next follow-up on"), required: false },
    ]);
    expect(r.steps.map((p) => [p.seq, p.kind, p.status, p.bundleId, p.bundleKind])).toEqual([
      [0, "draft_message", "pending", r.card?.id, "wait_unanswered"],
      [1, "update_dependency", "pending", r.card?.id, "wait_unanswered"],
    ]);
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({
      workItemId: "w1",
      ref: r.card?.id,
      applied: true,
      actor: "secretary",
    });
    expect(r.open).toEqual([
      expect.objectContaining({ id: r.card?.id, steps: 2, keys: ["PAY-12"], itemName: "Item w1" }),
    ]);
  });

  test("the same situation is offered once, whatever became of it; a changed fact is new", async () => {
    const { run: go } = workTestLayer();
    const r = await go(
      Effect.gen(function* () {
        yield* seedBase;
        yield* run();
        yield* seedItem("w1", ["PAY-12"]);
        yield* seedWait("d1", "PAY-12", { nextFollowupAt: day(-1) });
        const first = yield* run();
        const again = yield* run();
        // As a dismiss leaves it: the card dismissed, its steps rejected.
        yield* query((d) =>
          d
            .update(inboxItems)
            .set({ status: "dismissed" })
            .where(eq(inboxItems.source, "secretary")),
        );
        yield* query((d) => d.update(proposals).set({ status: "rejected" }));
        const afterDismiss = yield* run();
        yield* query((d) =>
          d
            .update(dependencies)
            .set({ nextFollowupAt: day(-2) })
            .where(eq(dependencies.id, "d1")),
        );
        const changed = yield* run();
        return { first, again, afterDismiss, changed, all: yield* cards };
      }),
    );
    expect([r.first.offered, r.again.offered, r.afterDismiss.offered, r.changed.offered]).toEqual([
      1, 0, 0, 1,
    ]);
    expect(new Set(r.all.map((c) => c.situationKey)).size).toBe(2);
  });

  test("at most five a pass, the current item first, then by the rules' order", async () => {
    const { run: go } = workTestLayer();
    const r = await go(
      Effect.gen(function* () {
        yield* seedBase;
        // Six items with a chase due, the current one created last.
        for (const [i, id] of ["wa", "wb", "wc", "wd", "we"].entries()) {
          yield* seedItem(id, [`OPS-${i + 1}`], { at: `2026-01-0${i + 1}T00:00:00.000Z` });
          yield* seedWait(`d-${id}`, `OPS-${i + 1}`, { nextFollowupAt: day(3) });
        }
        yield* seedItem("w-cur", ["CUR-1"], { current: true, at: "2026-02-01T00:00:00.000Z" });
        yield* seedWait("d-cur", "CUR-1", { nextFollowupAt: day(3) });
        // One whose next date is about to move.
        yield* seedItem("w-move", ["PAY-12"], {
          state: state(day(-2)),
          at: "2026-03-01T00:00:00.000Z",
        });
        yield* seedWait("d-move", "PAY-12", { expectedAt: day(-2) });
        // The first run remembers what it saw and offers nothing.
        const remembered = yield* run();
        // Then six chases fall due and the date moves: seven new situations.
        yield* query((d) =>
          d
            .update(dependencies)
            .set({ nextFollowupAt: day(-1) })
            .where(ne(dependencies.id, "d-move")),
        );
        yield* query((d) =>
          d
            .update(workItems)
            .set({ state: state(day(5)) })
            .where(eq(workItems.id, "w-move")),
        );
        const pass1 = yield* run();
        const order1 = (yield* offeredEvents).map((e) => [
          e.workItemId,
          (e.data as { rule: string }).rule,
        ]);
        const pass2 = yield* run();
        const pass3 = yield* run();
        return { remembered, pass1, order1, pass2, pass3, events: yield* offeredEvents };
      }),
    );
    expect(r.remembered.offered).toBe(0);
    expect(r.pass1).toEqual({ offered: OUTCOMES_PER_PASS, situations: 7 });
    expect(r.order1).toEqual([
      ["w-cur", "wait_unanswered"],
      ["w-move", "expected_date_moved"],
      ["wa", "wait_unanswered"],
      ["wb", "wait_unanswered"],
      ["wc", "wait_unanswered"],
    ]);
    expect(r.pass2.offered).toBe(2);
    expect(r.pass3.offered).toBe(0);
    expect(r.events.slice(5).map((e) => e.workItemId)).toEqual(["wd", "we"]);
  });

  test("a moved date counts once; switched off, nothing", async () => {
    const { run: go } = workTestLayer();
    const r = await go(
      Effect.gen(function* () {
        yield* seedBase;
        yield* seedItem("w1", ["PAY-12"], { state: state(day(-2)) });
        yield* seedWait("d1", "PAY-12", { expectedAt: day(-2) });
        // Due before every new date, so each move has a due-date step.
        yield* query((d) =>
          d
            .update(jiraIssues)
            .set({ dueDate: day(1) })
            .where(eq(jiraIssues.key, "PAY-12")),
        );
        yield* run();
        yield* query((d) =>
          d
            .update(workItems)
            .set({ state: state(day(5)) })
            .where(eq(workItems.id, "w1")),
        );
        const off = defaultSettings();
        off.secretary.rules.expected_date_moved = false;
        const switchedOff = yield* run(off);
        // Back on: the move was seen while the rule was off, so it is not news now.
        const backOn = yield* run();
        yield* query((d) =>
          d
            .update(workItems)
            .set({ state: state(day(9)) })
            .where(eq(workItems.id, "w1")),
        );
        const moved = yield* run();
        const again = yield* run();
        return { switchedOff, backOn, moved, again };
      }),
    );
    expect(r.switchedOff.offered).toBe(0);
    expect(r.backOn.offered).toBe(0);
    expect(r.moved.offered).toBe(1);
    expect(r.again.offered).toBe(0);
  });

  test("the first run reads no old comments; a new one after it is news", async () => {
    const { run: go } = workTestLayer();
    const comment = (ref: string) =>
      appendEvents([
        {
          kind: "jira_comment",
          actor: "jira:ana.b",
          issueKey: "PAY-12",
          ref,
          summary: "Ana commented on PAY-12",
          data: { field: "comment", text: "Can you check the cert?" },
          workItemId: "w1",
          attachedBy: "code",
        },
      ]);
    const r = await go(
      Effect.gen(function* () {
        yield* seedBase;
        yield* seedItem("w1", ["PAY-12"]);
        yield* comment("c-old");
        const first = yield* run();
        yield* comment("c-new");
        const second = yield* run();
        const [card] = yield* query((d) =>
          d
            .select()
            .from(inboxItems)
            .where(and(eq(inboxItems.source, "secretary"), eq(inboxItems.workItemId, "w1")))
            .all(),
        );
        return { first, second, card };
      }),
    );
    expect(r.first.offered).toBe(0);
    expect(r.second.offered).toBe(1);
    expect(r.card?.summary).toBe("ana.b asks you something on PAY-12");
    // Ana is no contact, so the card is the reminder alone.
    expect(situationOf(r.card?.triage)?.steps).toEqual([]);
  });

  test("the first run offers nothing: what holds already is known while it holds", async () => {
    const { run: go } = workTestLayer();
    const r = await go(
      Effect.gen(function* () {
        yield* seedBase;
        yield* seedItem("w1", ["PAY-12"]);
        yield* seedWait("d1", "PAY-12", { nextFollowupAt: day(-1) });
        const first = yield* run();
        const second = yield* run();
        // The fact changes: a new situation.
        yield* query((d) =>
          d
            .update(dependencies)
            .set({ nextFollowupAt: day(-2) })
            .where(eq(dependencies.id, "d1")),
        );
        const changed = yield* run();
        return { first, second, changed };
      }),
    );
    expect([r.first.offered, r.second.offered, r.changed.offered]).toEqual([0, 0, 1]);
  });

  test("capped items are seen through: the rest come next pass, nothing twice", async () => {
    const { run: go } = workTestLayer();
    const comment = (item: string, key: string, ref: string) =>
      appendEvents([
        {
          kind: "jira_comment",
          actor: "jira:ana.b",
          issueKey: key,
          ref,
          summary: `Ana commented on ${key}`,
          data: { field: "comment", text: "Thoughts?" },
          workItemId: item,
          attachedBy: "code",
        },
      ]);
    const r = await go(
      Effect.gen(function* () {
        yield* seedBase;
        const ids = ["wa", "wb", "wc", "wd", "we", "wf", "wg"];
        for (const [i, id] of ids.entries())
          yield* seedItem(id, [`OPS-${i + 1}`], { at: `2026-01-0${i + 1}T00:00:00.000Z` });
        yield* run();
        for (const [i, id] of ids.entries()) yield* comment(id, `OPS-${i + 1}`, `c-${id}`);
        const pass1 = yield* run();
        // A new comment on an item already offered is one new card about that comment only.
        yield* comment("wa", "OPS-1", "c-wa-2");
        const pass2 = yield* run();
        const pass3 = yield* run();
        const all = yield* cards;
        return { pass1, pass2, pass3, all };
      }),
    );
    expect(r.pass1.offered).toBe(5);
    expect(r.pass2.offered).toBe(3);
    expect(r.pass3.offered).toBe(0);
    expect(r.all).toHaveLength(8);
    const comments = r.all.map((c) => situationOf(c.triage)?.comments);
    expect(comments).toContainEqual(["c-wa-2"]);
    expect(new Set(comments.flat()).size).toBe(8);
  });
});

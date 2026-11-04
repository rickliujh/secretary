/**
 * The intake run's edges (D68, Phase 32 review): items a stopped turn did not
 * read survive a later reply until Resume reads them; a card approved while a
 * revision runs is never superseded nor put back by Edit; a stop while the
 * playbooks expand leaves no item behind; a chore approved meanwhile stays; a
 * turn written item by item matches the end-of-turn merge and expansion, a
 * playbook bundle trimmed to one step and questions included.
 */
import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { Effect, Exit, Fiber } from "effect";
import { inboxItems, intakeItems, people, proposals } from "@/db/schema";
import { localDate } from "@/lib/dates";
import { type ItemOutput, type ItemSnapshot, mapItemOutput } from "@/prompts/classify";
import { query } from "@/services/db";
import type { Scripted } from "@/services/llm/test";
import { effectivePayload } from "@/services/proposals/schema";
import { expandTurn } from "@/services/work/playbooks/expand";
import { readThread, TODAY } from "@/test/helpers";
import { intakeTestLayer, out } from "@/test/intake-layer";
import { syncOnce } from "@/test/seed";
import { json } from "@/test/stub-fetch";
import { Intake, type RunEvent } from ".";
import { mergeItemProposals } from "./merge";
import { runRecordOf, unreadOf } from "./record";

const e = { rationale: "because", evidence: "from the notes", confidence: 0.8 };
const BOB = "p-bob";

const quote1 = "First: I am waiting on Bob for the signed contract for PAY-2 before we can go on.";
const quote2 = "Second: comment on PAY-2 that the contract is late, and message Bob about it.";
const long = [
  "Notes from the payments sync.",
  quote1,
  ...Array.from({ length: 8 }, (_, i) => `Point ${i + 1}: nothing to do.`),
  quote2,
  "That is all.",
].join("\n");
const split = out({
  items: [
    { quote: quote1, topic: "contract" },
    { quote: quote2, topic: "comment" },
  ],
});
const answer = (summary: string, ps: Record<string, unknown>[], question: string | null = null) =>
  out({ summary, question, confidence: 0.9, proposals: ps });
const story = (summary: string) => ({
  kind: "create_issue",
  ref: "$new:1",
  projectKey: "PAY",
  issueType: "Story",
  summary,
  description: null,
  parent: null,
  epic: null,
  priority: null,
  assignee: null,
  dueDate: null,
  ...e,
});
const wait = {
  kind: "link_dependency",
  target: "PAY-2",
  dependencyKind: "person",
  label: "the signed contract",
  ownerPersonId: BOB,
  expectedAt: null,
  ...e,
};
const comment = { kind: "add_comment", target: "PAY-2", body: "The contract is late.", ...e };
const draft = {
  kind: "draft_message",
  channel: "teams",
  intent: "request",
  recipientPersonId: BOB,
  issueKeys: ["PAY-2"],
  notes: "Ask for the signed contract.",
  ...e,
};
const hang: Scripted = { hang: true };

const seedBob = (projects = false) =>
  query((d) =>
    d.insert(people).values({
      id: BOB,
      displayName: "Bob Ray",
      email: "bob@example.com",
      ...(projects ? { jiraProjects: [{ key: "PLAT", by: "user" as const }] } : {}),
    }),
  );

/** Starts a turn in a fiber; resolves `at` when `when` sees its event. */
const watch = (when: (e: RunEvent) => boolean) => {
  const events: RunEvent[] = [];
  let hit: () => void = () => undefined;
  const at = new Promise<void>((r) => {
    hit = r;
  });
  const onEvent = (ev: RunEvent) => {
    events.push(ev);
    if (when(ev)) hit();
  };
  return { events, onEvent, at: Effect.promise(() => at) };
};
const storedOf = (events: RunEvent[]) => {
  const s = events.find((ev) => ev.type === "stored");
  return s?.type === "stored" ? s : { inboxItemId: "", messageId: "" };
};

const props = (inboxItemId: string) =>
  query((d) => d.select().from(proposals).where(eq(proposals.inboxItemId, inboxItemId)).all());

describe("the intake run's edges (D68)", () => {
  test("a reply after a stop keeps the unread item; resume reads exactly it", async () => {
    const lone = (s: string) => answer(s, [story(s)]);
    const { layer, models } = intakeTestLayer(
      {
        "fast-m": [split],
        "std-m": [
          lone("Backfill August refund totals"),
          hang,
          lone("Rotate ledger TLS certificate"),
          lone("Archive July ledger exports"),
        ],
      },
      [],
      { llm: { timeoutMs: 5_000 } },
    );
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const intake = yield* Intake;
          const w = watch((ev) => ev.type === "attempt" && ev.item === 1);
          const fiber = yield* Effect.fork(
            intake.triage({
              text: long,
              source: "email",
              senderPersonId: null,
              today: TODAY,
              onEvent: w.onEvent,
            }),
          );
          yield* w.at;
          yield* Effect.sleep(20);
          yield* Fiber.interrupt(fiber);
          const { inboxItemId, messageId } = storedOf(w.events);
          // A new turn on the thread: a reply that reads new input.
          yield* intake.reply({
            inboxItemId,
            parts: [{ type: "pasted", text: "Please archive the July ledger exports in PAY." }],
            source: "email",
          });
          const between = (yield* readThread(inboxItemId)).item?.triage;
          const resumed = yield* intake.resume(inboxItemId, { messageId });
          const after = yield* readThread(inboxItemId);
          return { between, resumed, after, messageId };
        }),
        layer,
      ),
    );
    // The reply did not wipe the stopped turn's item: it waits in `unread`.
    const unread = unreadOf(r.between);
    expect(unread.map((u) => [u.messageId, u.undecided.map((j) => j.pos)])).toEqual([
      [r.messageId, [1]],
    ]);
    expect(runRecordOf(r.between)?.messageId).not.toBe(r.messageId);
    // Resume decides exactly that item: one more classify call, its card, nothing else.
    expect(r.resumed).toMatchObject({ items: 1, proposals: 1 });
    expect(models.calls.map((c) => c.model)).toEqual([
      "fast-m",
      "std-m",
      "std-m",
      "std-m",
      "std-m",
    ]);
    expect(r.after.props.map((p) => (p.payload as { summary?: string }).summary).sort()).toEqual([
      "Archive July ledger exports",
      "Backfill August refund totals",
      "Rotate ledger TLS certificate",
    ]);
    expect(unreadOf(r.after.item?.triage)).toEqual([]);
  });

  test("a card approved while its item is revised is never superseded, nor put back by Edit", async () => {
    const one = "Please make a PAY story to backfill the August refund totals.";
    const { layer } = intakeTestLayer(
      {
        "std-m": [
          answer("Refunds", [story("Backfill August refund totals")]),
          hang,
          answer("Refunds", [{ ...story("Backfill August refund totals"), priority: "High" }]),
        ],
      },
      [],
      { llm: { timeoutMs: 300, pausesMs: [10, 10] } },
    );
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const intake = yield* Intake;
          const first = yield* intake.triage({
            text: one,
            source: "typed",
            senderPersonId: null,
            today: TODAY,
          });
          const [old] = yield* props(first.inboxItemId);
          const w = watch((ev) => ev.type === "attempt" && ev.attempt.number === 1);
          const fiber = yield* Effect.fork(
            intake.reply({
              inboxItemId: first.inboxItemId,
              parts: [{ type: "typed", text: "priority High" }],
              onEvent: w.onEvent,
            }),
          );
          yield* w.at;
          // Approved (and run) while the revision waits for its model.
          yield* query((d) =>
            d
              .update(proposals)
              .set({ status: "executed", result: { issueKey: "PAY-77" } })
              .where(eq(proposals.id, old?.id ?? "")),
          );
          const exit = yield* Fiber.await(fiber);
          const during = yield* props(first.inboxItemId);
          const { messageId } = storedOf(w.events);
          yield* intake.withdraw(messageId ?? "");
          const after = yield* props(first.inboxItemId);
          return { exit, old, during, after };
        }),
        layer,
      ),
    );
    expect(Exit.isSuccess(r.exit)).toBe(true);
    const oldDuring = r.during.find((p) => p.id === r.old?.id);
    expect(oldDuring).toMatchObject({ status: "executed", result: { issueKey: "PAY-77" } });
    // Edit took the reply's card back and left the executed one as it ran.
    expect(r.after.map((p) => [p.id, p.status])).toEqual([[r.old?.id, "executed"]]);
    expect(r.after[0]?.result).toEqual({ issueKey: "PAY-77" });
  });

  test("a stop while the playbooks expand leaves no item behind and the item unread", async () => {
    let stop: () => void = () => undefined;
    const search = {
      // The playbook's search in Bob's project, not the sync's.
      match: (u: URL, req: { body: unknown }) =>
        u.pathname.endsWith("/search") && JSON.stringify(req.body).includes("PLAT"),
      respond: async () => {
        stop();
        await new Promise((r) => setTimeout(r, 3_000));
        return json({ startAt: 0, maxResults: 10, total: 0, issues: [] });
      },
    };
    const { layer } = intakeTestLayer(
      { "std-m": [answer("Waiting on Bob", [wait]), answer("Waiting on Bob", [wait])] },
      [search],
    );
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          yield* seedBob(true);
          const intake = yield* Intake;
          const events: RunEvent[] = [];
          const fiber = yield* Effect.fork(
            intake.triage({
              text: "I'm waiting on Bob for the signed contract for PAY-2",
              source: "typed",
              senderPersonId: null,
              today: TODAY,
              onEvent: (ev) => events.push(ev),
            }),
          );
          yield* Effect.promise(
            () =>
              new Promise<void>((res) => {
                stop = res;
              }),
          );
          yield* Fiber.interrupt(fiber);
          const { inboxItemId } = storedOf(events);
          const items = yield* query((d) =>
            d.select().from(intakeItems).where(eq(intakeItems.inboxItemId, inboxItemId)).all(),
          );
          const item = yield* query((d) =>
            d.select().from(inboxItems).where(eq(inboxItems.id, inboxItemId)).get(),
          );
          stop = () => undefined;
          return { items, record: runRecordOf(item?.triage), rows: yield* props(inboxItemId) };
        }),
        layer,
      ),
    );
    expect(r.items).toHaveLength(0);
    expect(r.rows).toHaveLength(0);
    expect(r.record).toMatchObject({ state: "stopped", decided: 0, itemIds: [] });
    expect(r.record?.undecided).toHaveLength(1);
  });

  test("a chore step approved meanwhile stays when a later item proposes it", async () => {
    const { layer } = intakeTestLayer(
      {
        "fast-m": [split],
        "std-m": [answer("Waiting on Bob", [wait]), hang, answer("Comment", [comment])],
      },
      [],
      { llm: { timeoutMs: 300, pausesMs: [10, 10] } },
    );
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          yield* seedBob();
          const intake = yield* Intake;
          const w = watch((ev) => ev.type === "attempt" && ev.item === 1);
          const fiber = yield* Effect.fork(
            intake.triage({
              text: long,
              source: "email",
              senderPersonId: null,
              today: TODAY,
              onEvent: w.onEvent,
            }),
          );
          yield* w.at;
          const { inboxItemId } = storedOf(w.events);
          // The bundle's comment step is approved while item 2 is read.
          yield* query((d) =>
            d
              .update(proposals)
              .set({ status: "executed" })
              .where(
                and(eq(proposals.inboxItemId, inboxItemId), eq(proposals.kind, "add_comment")),
              ),
          );
          yield* Fiber.await(fiber);
          return yield* readThread(inboxItemId);
        }),
        layer,
      ),
    );
    const executed = r.props.filter((p) => p.status === "executed");
    expect(executed.map((p) => p.kind)).toEqual(["add_comment"]);
    // It stays in its bundle, and on the bundle's card.
    expect(executed[0]?.bundleId).toBeTruthy();
  });

  test("written item by item = merged and expanded at once: a bundle trimmed to one step, questions", async () => {
    const { layer } = intakeTestLayer({
      "fast-m": [split],
      "std-m": [
        answer("Waiting on Bob", [wait], "When did Bob promise it?"),
        answer("Comment and message", [comment, draft]),
      ],
    });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          yield* seedBob();
          const res = yield* (yield* Intake).triage({
            text: long,
            source: "email",
            senderPersonId: null,
            today: TODAY,
          });
          const thread = yield* readThread(res.inboxItemId);
          // The old way: every item merged, then expanded, at the end of the turn.
          const sorted = [...thread.items].sort((a, b) => a.idx - b.idx);
          const merged = mergeItemProposals(
            sorted.map((i) =>
              mapItemOutput(i.output as ItemOutput, i.quote, i.snapshot as ItemSnapshot),
            ),
          );
          const expanded = yield* expandTurn(merged, {
            senderPersonId: null,
            today: localDate(),
            dropped: [],
          });
          return { thread, expanded, itemIds: sorted.map((i) => i.id) };
        }),
        layer,
      ),
    );
    const shape = (p: { payload: unknown; bundleId: string | null }) =>
      JSON.stringify([p.payload, !!p.bundleId]);
    const actions = r.thread.props.filter((p) => p.kind !== "needs_clarification");
    expect(
      actions.map((p) => shape({ payload: effectivePayload(p), bundleId: p.bundleId })).sort(),
    ).toEqual(r.expanded.proposals.map(shape).sort());
    // The wait's playbook lost both chores to item 2's own: it is its proposal alone.
    expect(r.expanded.bundles).toEqual([]);
    expect(actions.map((p) => [p.kind, p.bundleId])).toEqual([
      ["link_dependency", null],
      ["add_comment", null],
      ["draft_message", null],
    ]);
    // The question is item 1's, after item 1's cards and before item 2's.
    const seqs = r.thread.props.map((p) => [p.kind, p.intakeItemId === r.itemIds[0] ? 1 : 2]);
    expect(seqs).toEqual([
      ["link_dependency", 1],
      ["needs_clarification", 1],
      ["add_comment", 2],
      ["draft_message", 2],
    ]);
  });
});

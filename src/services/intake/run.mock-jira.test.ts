/**
 * FR-21 acceptance (Phase 32): the Inbox's run store driving the real Intake,
 * Retrieval, Sync and Llm against scripts/mock-jira.ts over HTTP; only the
 * model is scripted, with short call timeouts and pauses. A two-item message
 * whose second item's first two calls time out finishes on the third attempt; a
 * stop after item 1 keeps its cards and a resume decides only item 2; Edit
 * takes the message and its new thread back; a message sent during a run starts
 * after it; a correction added during a run is sent as a follow-up; the run is
 * there for whoever reads the store again; a third timeout fails its item only.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Exit, Layer, ManagedRuntime } from "effect";
import { inboxItems, inboxMessages, proposals } from "@/db/schema";
import { query } from "@/services/db";
import { ExecutorLive } from "@/services/executor/live";
import { IntakeLive } from "@/services/intake/live";
import { makeLlmLayer } from "@/services/llm/live";
import { makeScriptedModels, type Scripted } from "@/services/llm/test";
import { Proposals } from "@/services/proposals";
import { ProposalsLive } from "@/services/proposals/live";
import { RetrievalLive } from "@/services/retrieval/live";
import { Sync } from "@/services/sync";
import { SyncLive } from "@/services/sync/live";
import { testProvider } from "@/test/helpers";
import { out } from "@/test/intake-layer";
import { jiraSettings, jiraTestLayer } from "@/test/layers";
import { createHandler, generate } from "../../../scripts/mock-jira";
import { Intake } from ".";
import { createRunStore, type Run, type RunRequest, viewOf } from "./runs";

const servers: { stop: (force?: boolean) => void }[] = [];
const runtimes: { dispose: () => Promise<void> }[] = [];
afterAll(async () => {
  for (const s of servers) s.stop(true);
  for (const r of runtimes) await r.dispose();
});

const e = { rationale: "From the notes", evidence: "notes", confidence: 0.9 };
const story = (summary: string) => ({
  kind: "create_issue",
  ref: "$new:1",
  projectKey: "PAY",
  issueType: "Story",
  summary,
  ...e,
});
const answer = (summary: string, ...ps: Record<string, unknown>[]) =>
  out({ summary, question: null, confidence: 0.9, proposals: ps });

const quote1 =
  "First: PAY needs a story to backfill the August refund totals in the ledger export.";
const quote2 = "Second: PAY needs a story to rotate the ledger TLS certificate before it lapses.";
const long = [
  "Notes from the payments sync.",
  quote1,
  ...Array.from({ length: 8 }, (_, i) => `Point ${i + 1}: nothing to do.`),
  quote2,
  "That is all.",
].join("\n");
const split = out({
  items: [
    { quote: quote1, topic: "refunds" },
    { quote: quote2, topic: "certificate" },
  ],
});
const item1 = answer("Refund backfill", story("Backfill August refund totals"));
const item2 = answer("Certificate rotation", story("Rotate ledger TLS certificate"));
const hang: Scripted = { hang: true };

const triage: RunRequest = {
  kind: "triage",
  input: { text: long, source: "email", senderPersonId: null, today: "2026-11-04" },
};

function setup(scripts: Record<string, Scripted[]>) {
  const issues = generate(60);
  const server = Bun.serve({ port: 0, fetch: createHandler(issues) });
  servers.push(server);
  const base = jiraTestLayer((input, init) => fetch(input, init), {
    ...jiraSettings({ baseUrl: `http://localhost:${server.port}`, trackedEpics: [] }),
    providers: [testProvider],
    tiers: {
      fast: { providerId: "p1", model: "fast-m" },
      standard: { providerId: "p1", model: "std-m" },
      strong: null,
    },
  });
  const models = makeScriptedModels(scripts);
  const llm = Layer.provideMerge(
    makeLlmLayer({ timeoutMs: 150, pausesMs: [20, 20] }),
    Layer.merge(Layer.provideMerge(SyncLive, base), models.layer),
  );
  const layer = Layer.provideMerge(
    Layer.merge(IntakeLive, ProposalsLive),
    Layer.provideMerge(Layer.merge(RetrievalLive, ExecutorLive), llm),
  );
  const runtime = ManagedRuntime.make(layer);
  runtimes.push(runtime);
  const started: string[] = [];
  const store = createRunStore({
    execute: async (run, c) => {
      started.push(run.id);
      const control = { onEvent: c.onEvent, skip: c.skip };
      const req = run.request;
      const exit = await runtime.runPromiseExit(
        Effect.flatMap(Intake, (i) =>
          req.kind === "triage"
            ? i.triage({ ...req.input, ...control })
            : req.kind === "reply"
              ? i.reply({ ...req.input, ...control })
              : req.kind === "resume"
                ? i.resume(req.inboxItemId, { ...control, ...(req.tier ? { tier: req.tier } : {}) })
                : i.retriage(req.inboxItemId, control),
        ),
        { signal: c.signal },
      );
      if (Exit.isSuccess(exit)) return exit.value;
      throw exit.cause;
    },
    withdraw: (messageId) =>
      runtime.runPromise(Effect.flatMap(Intake, (i) => i.withdraw(messageId))),
  });
  const db = <A, E>(program: Effect.Effect<A, E, never>) => runtime.runPromise(program as never);
  return { runtime, store, models, started, db, issues };
}

/** Polls the store until `f` holds (the runs end on their own time). */
async function until(f: () => boolean, ms = 4_000) {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const attemptsOf = (run: Run | undefined, item: number) =>
  (run?.events ?? []).filter((e) => e.type === "attempt" && e.item === item).length;

const rowsOf = (s: ReturnType<typeof setup>, inboxItemId: string) =>
  s.runtime.runPromise(
    query((d) => d.select().from(proposals).where(eq(proposals.inboxItemId, inboxItemId)).all()),
  );

describe("the intake run against the mock Jira (FR-21 AC)", () => {
  test("two timeouts on item 2 then an answer: every card, three attempts in the run", async () => {
    const s = setup({ "fast-m": [split], "std-m": [item1, hang, hang, item2] });
    await s.runtime.runPromise(Effect.flatMap(Sync, (x) => x.run()));
    const id = s.store.startRun(triage, { lane: "new" });
    await until(() => s.store.get(id)?.state === "done");
    const run = s.store.get(id);
    expect(attemptsOf(run, 1)).toBe(3);
    expect(viewOf(run as Run, Date.now())).toMatchObject({ cards: 2, decided: 2 });
    const rows = await rowsOf(s, run?.inboxItemId ?? "");
    expect(rows.map((r) => (r.payload as { summary: string }).summary).sort()).toEqual([
      "Backfill August refund totals",
      "Rotate ledger TLS certificate",
    ]);
  });

  test("a stop after item 1 keeps its cards; a resume decides only item 2", async () => {
    const s = setup({ "fast-m": [split], "std-m": [item1, hang, item2] });
    await s.runtime.runPromise(Effect.flatMap(Sync, (x) => x.run()));
    const id = s.store.startRun(triage, { lane: "new" });
    await until(() => attemptsOf(s.store.get(id), 1) > 0);
    // The run is there for any reader of the store while it goes (a thread reopened).
    expect(s.store.runFor(s.store.get(id)?.inboxItemId ?? "")?.id).toBe(id);
    await new Promise((r) => setTimeout(r, 20));
    s.store.stop(id);
    await until(() => s.store.get(id)?.state === "stopped");
    const thread = s.store.get(id)?.inboxItemId ?? "";
    expect((await rowsOf(s, thread)).map((r) => r.kind)).toEqual(["create_issue"]);
    // Resume runs in the same record and reads item 2 alone.
    expect(s.store.resume(thread)).toBe(id);
    await until(() => s.store.get(id)?.state === "done");
    expect(s.models.calls.map((c) => c.model)).toEqual(["fast-m", "std-m", "std-m", "std-m"]);
    expect(await rowsOf(s, thread)).toHaveLength(2);
  });

  test("Edit withdraws the message and the thread that held nothing else", async () => {
    const s = setup({ "fast-m": [split], "std-m": [hang] });
    await s.runtime.runPromise(Effect.flatMap(Sync, (x) => x.run()));
    const id = s.store.startRun(triage, { lane: "new" });
    await until(() => attemptsOf(s.store.get(id), 0) > 0);
    const thread = s.store.get(id)?.inboxItemId ?? "";
    expect(s.store.edit(id)).toBe("new");
    await until(() => s.store.get(id)?.state === "stopped");
    await new Promise((r) => setTimeout(r, 50));
    const left = await s.runtime.runPromise(
      query((d) => d.select().from(inboxItems).where(eq(inboxItems.id, thread)).all()),
    );
    expect(left).toHaveLength(0);
    expect(s.store.takeDraft("new")?.length).toBeGreaterThan(0);
  });

  test("a message sent during a run starts after it; a correction is a follow-up", async () => {
    const s = setup({
      "fast-m": [split],
      "std-m": [item1, item2, answer("Second thread", story("Archive the July ledger exports"))],
    });
    await s.runtime.runPromise(Effect.flatMap(Sync, (x) => x.run()));
    const a = s.store.startRun(triage, { lane: "new" });
    const b = s.store.startRun(
      {
        kind: "triage",
        input: {
          parts: [{ type: "typed", text: "Archive the July ledger exports in PAY." }],
          source: "typed",
          senderPersonId: null,
        },
      },
      { lane: "new" },
    );
    expect(s.store.get(b)?.state).toBe("queued");
    s.store.addCorrection(a, "make them both High");
    await until(() => !!s.store.get(a)?.inboxItemId);
    const thread = s.store.get(a)?.inboxItemId ?? "";
    await until(() => s.store.get(a)?.state === "done");
    // The correction goes first, then the queued message.
    await until(() => s.started.length >= 2);
    const follow = s.started[1] ?? "";
    expect(s.store.get(follow)?.request).toEqual({
      kind: "reply",
      input: { inboxItemId: thread, parts: [{ type: "typed", text: "make them both High" }] },
    });
    expect(s.started.indexOf(b)).toBeGreaterThan(s.started.indexOf(a));
    await until(() => s.store.get(follow)?.messageId != null);
    const messages = await s.runtime.runPromise(
      query((d) =>
        d.select().from(inboxMessages).where(eq(inboxMessages.inboxItemId, thread)).all(),
      ),
    );
    expect(JSON.stringify(messages.map((m) => m.content))).toContain("make them both High");
  });

  test("a timed-out third attempt fails that item only", async () => {
    const s = setup({ "fast-m": [split], "std-m": [hang, hang, hang, item2] });
    await s.runtime.runPromise(Effect.flatMap(Sync, (x) => x.run()));
    const id = s.store.startRun(triage, { lane: "new" });
    await until(() => s.store.get(id)?.state === "failed");
    const run = s.store.get(id) as Run;
    const view = viewOf(run, Date.now());
    expect(view.failedItems).toEqual([0]);
    expect(view.decided).toBe(1);
    const rows = await rowsOf(s, run.inboxItemId ?? "");
    expect(rows.map((r) => (r.payload as { summary: string }).summary)).toEqual([
      "Rotate ledger TLS certificate",
    ]);
  });

  test("Approve all runs the cards of all items in order: a later item's comment on an earlier create", async () => {
    const refunds = story("Backfill August refund totals");
    const s = setup({
      "fast-m": [split],
      "std-m": [
        item1,
        // The same create (it collapses into item 1's) and a comment on it.
        answer("Refunds sign-off", refunds, {
          kind: "add_comment",
          target: "$new:1",
          body: "Finance signed off on the totals.",
          ...e,
        }),
      ],
    });
    await s.runtime.runPromise(Effect.flatMap(Sync, (x) => x.run()));
    const id = s.store.startRun(triage, { lane: "new" });
    await until(() => s.store.get(id)?.state === "done");
    const thread = s.store.get(id)?.inboxItemId ?? "";
    const before = await rowsOf(s, thread);
    // Item 2's comment comes after item 1's create.
    expect(before.map((r) => [r.kind, (r.payload as { target?: string }).target ?? null])).toEqual([
      ["create_issue", null],
      ["add_comment", "$new:1"],
    ]);
    await s.runtime.runPromise(Effect.flatMap(Proposals, (p) => p.approveAll(thread)));
    const after = await rowsOf(s, thread);
    expect(after.map((r) => r.status)).toEqual(["executed", "executed"]);
    const key = (after[0]?.result as { issueKey?: string } | null)?.issueKey ?? "";
    expect(s.issues.get(key)?.comments.map((c) => c.body)).toEqual([
      "Finance signed off on the totals.",
    ]);
  });
});

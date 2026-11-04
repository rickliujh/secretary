import { describe, expect, test } from "bun:test";
import type { AttemptEvent } from "@/services/llm";
import {
  applyEvent,
  createRunStore,
  doneLine,
  nextToStart,
  type QueuedMessage,
  type Run,
  type RunControl,
  type RunEvent,
  type RunRequest,
  viewOf,
} from "./runs";

const T0 = 1_000_000;

const base: Run = {
  id: "r1",
  lane: "t1",
  request: { kind: "reply", input: { inboxItemId: "t1", parts: [{ type: "typed", text: "hi" }] } },
  state: "running",
  inboxItemId: "t1",
  messageId: null,
  assistantMessageId: null,
  parts: [{ type: "typed", text: "hi" }],
  events: [],
  queuedAt: T0,
  startedAt: T0,
  endedAt: null,
  error: null,
  result: null,
  corrections: [],
  editing: false,
};

const attempt = (at: number, n: number, extra: Partial<AttemptEvent> = {}): AttemptEvent => ({
  task: "classify_item",
  number: n,
  failures: n - 1,
  of: 3,
  reason: n > 1 ? "timeout" : null,
  pauseMs: 0,
  tier: "standard",
  providerId: "p1",
  model: "std-m",
  repair: false,
  escalated: false,
  at,
  ...extra,
});

/** Stored, split into two, looked up, item 1 deciding from T0 + 2 s. */
const twoItems: RunEvent[] = [
  { type: "stored", at: T0, inboxItemId: "t1", messageId: "m1" },
  { type: "step", at: T0, name: "split", phase: "start", title: "Splitting into items" },
  {
    type: "step",
    at: T0 + 1000,
    name: "split",
    phase: "end",
    title: "Split into items",
    count: 2,
    detail: "2 items",
  },
  {
    type: "step",
    at: T0 + 1000,
    name: "lookup",
    phase: "start",
    title: "Looking up",
    count: 2,
  },
  {
    type: "step",
    at: T0 + 1300,
    name: "lookup",
    phase: "end",
    title: "Looked up",
    count: 2,
    detail: "PAY-12",
  },
  {
    type: "step",
    at: T0 + 2000,
    name: "decide",
    phase: "start",
    title: "Deciding item 1 of 2",
    item: 0,
    count: 2,
    detail: "the cert date",
  },
  { type: "attempt", at: T0 + 2000, item: 0, attempt: attempt(T0 + 2000, 1) },
];

const withEvents = (events: RunEvent[], patch: Partial<Run> = {}) =>
  events.reduce(applyEvent, { ...base, ...patch });

describe("run reducers (D68)", () => {
  test("stored names the run's thread and message; the first item done its answer", () => {
    const r = withEvents([
      { type: "stored", at: T0, inboxItemId: "t9", messageId: "m9" },
      {
        type: "item_done",
        at: T0,
        item: 0,
        count: 1,
        cards: 1,
        questions: 0,
        assistantMessageId: "a1",
      },
    ]);
    expect([r.inboxItemId, r.messageId, r.assistantMessageId]).toEqual(["t9", "m9", "a1"]);
  });

  test("a plain spinner for the first 5 s, then the steps", () => {
    const r = withEvents(twoItems);
    expect(viewOf(r, T0 + 3000).spinnerOnly).toBe(true);
    const v = viewOf(r, T0 + 24_000);
    expect(v.spinnerOnly).toBe(false);
    expect(v.title).toBe("Reading your reply");
    expect([v.tier, v.model]).toEqual(["standard", "std-m"]);
    expect(v.steps.map((s) => [s.title, s.status, s.sub])).toEqual([
      ["Split into items", "done", "2 items · 1 s"],
      ["Looked up", "done", "PAY-12 · 0.3 s"],
      ["Deciding item 1 of 2", "now", "the cert date · 22 s"],
      ["Deciding item 2 of 2", "pending", null],
    ]);
    expect(v.line).toBe("Deciding item 1 of 2 · 0:24");
    expect(v.slow).toBe(false);
  });

  test("the first item's cards; the slow notice after 30 s on one call", () => {
    const r = withEvents([
      ...twoItems,
      {
        type: "step",
        at: T0 + 25_000,
        name: "decide",
        phase: "end",
        title: "Deciding item 1 of 2",
        item: 0,
        count: 2,
      },
      {
        type: "item_done",
        at: T0 + 25_000,
        item: 0,
        count: 2,
        cards: 1,
        questions: 0,
        assistantMessageId: "a1",
      },
      {
        type: "step",
        at: T0 + 25_000,
        name: "decide",
        phase: "start",
        title: "Deciding item 2 of 2",
        item: 1,
        count: 2,
        detail: "the Q3 numbers",
      },
      { type: "attempt", at: T0 + 25_000, item: 1, attempt: attempt(T0 + 25_000, 1) },
    ]);
    const partial = viewOf(r, T0 + 31_000);
    expect(partial.steps[2]?.sub).toBe("the cert date · 23 s · 1 card");
    expect(partial.line).toBe("Deciding item 2 of 2 · 1 card so far");
    expect(partial.slow).toBe(false);
    const slow = viewOf(r, T0 + 56_000);
    expect(slow.slow).toBe(true);
    expect(slow.call).toMatchObject({ attempt: 1, item: 1 });
    expect(slow.line).toBe("Slow call · 0:56");
  });

  test("a retry shows its attempt, and waits out its pause", () => {
    const r = withEvents([
      ...twoItems,
      {
        type: "attempt",
        at: T0 + 122_000,
        item: 0,
        attempt: attempt(T0 + 122_000, 2, { pauseMs: 2000 }),
      },
    ]);
    const pausing = viewOf(r, T0 + 123_000);
    expect(pausing.retrying).toBe(true);
    expect(pausing.call).toMatchObject({ attempt: 2, failures: 1, pausing: true, ms: 0 });
    const v = viewOf(r, T0 + 128_000);
    expect(v.call?.pausing).toBe(false);
    expect(v.line).toBe("Attempt 2 of 3 · 2:08");
    expect(v.steps[2]?.sub).toBe("the cert date · attempt 2 · 2 min 6 s");
  });

  test("failed: the failed item is marked, the others keep their cards", () => {
    const r = withEvents(
      [
        ...twoItems,
        {
          type: "item_done",
          at: T0 + 25_000,
          item: 0,
          count: 2,
          cards: 1,
          questions: 0,
          assistantMessageId: "a1",
        },
        {
          type: "item_failed",
          at: T0 + 400_000,
          item: 1,
          count: 2,
          message: "No response within 120s",
          kind: "timeout",
        },
      ],
      {
        state: "failed",
        endedAt: T0 + 400_000,
        error: { message: "No response within 120s", kind: "timeout" },
      },
    );
    const v = viewOf(r, T0 + 500_000);
    expect(v.title).toBe("Could not finish");
    expect(v.failedItems).toEqual([1]);
    expect(v.undecided).toEqual([1]);
    expect(v.steps.at(-1)).toMatchObject({ status: "bad", sub: "No response within 120s" });
    expect(v.line).toBe("Failed · 1 card kept");
    expect(v.failure?.kind).toBe("timeout");
    expect(v.call).toBeNull();
  });

  test("stopped: what was not read says so", () => {
    const r = withEvents(twoItems, { state: "stopped", endedAt: T0 + 31_000 });
    const v = viewOf(r, T0 + 60_000);
    expect(v.title).toBe("Stopped");
    expect(v.elapsedMs).toBe(31_000);
    expect(v.steps.slice(2).map((s) => [s.status, s.sub])).toEqual([
      ["stopped", "the cert date · stopped"],
      ["stopped", "not read"],
    ]);
    expect(v.line).toBe("Stopped · nothing kept");
  });

  test("done: one line with time, cards, questions and calls", () => {
    const r = withEvents(
      [
        ...twoItems,
        {
          type: "attempt",
          at: T0 + 10_000,
          item: 0,
          attempt: attempt(T0 + 10_000, 1, { repair: true, task: "repair_output" }),
        },
        {
          type: "item_done",
          at: T0 + 25_000,
          item: 0,
          count: 2,
          cards: 1,
          questions: 0,
          assistantMessageId: "a1",
        },
        {
          type: "item_done",
          at: T0 + 40_000,
          item: 1,
          count: 2,
          cards: 2,
          questions: 0,
          assistantMessageId: "a1",
        },
      ],
      { state: "done", endedAt: T0 + 41_000 },
    );
    const v = viewOf(r, T0 + 90_000);
    expect(v.title).toBe("Read in 41 s");
    expect(doneLine(v)).toBe("Done in 41 s · 3 cards, 0 questions · 2 model calls (1 repair)");
    expect(v.line).toBe("3 cards waiting");
  });

  test("one lane, first in first out", () => {
    const q = (id: string, state: Run["state"]) => ({ ...base, id, state });
    expect(nextToStart([q("a", "done"), q("b", "queued"), q("c", "queued")])?.id).toBe("b");
    expect(nextToStart([q("a", "running"), q("b", "queued")])).toBeNull();
    expect(nextToStart([q("a", "stopping"), q("b", "queued")])).toBeNull();
  });
});

/** A store whose runs end when the test says. */
function harness() {
  const pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void; control: RunControl }
  >();
  const withdrawn: string[] = [];
  const started: RunRequest[] = [];
  const kept: QueuedMessage[][] = [];
  let clock = T0;
  let n = 0;
  const store = createRunStore({
    execute: (run, control) =>
      new Promise((resolve, reject) => {
        started.push(run.request);
        pending.set(run.id, { resolve: resolve as never, reject, control });
        control.signal.addEventListener("abort", () => reject(new Error("interrupted")));
      }),
    withdraw: async (messageId) => {
      withdrawn.push(messageId);
      return { inboxItemId: "t1", thread: false };
    },
    now: () => clock,
    newId: () => `run-${++n}`,
    onQueue: (q) => kept.push(q),
  });
  const done = async (id: string) => {
    pending.get(id)?.resolve({ inboxItemId: "t1", items: 1, proposals: 1, questions: 0 });
    await Promise.resolve();
    await Promise.resolve();
  };
  const settle = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return {
    store,
    pending,
    withdrawn,
    kept,
    started,
    done,
    settle,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

const reply = (text: string, inboxItemId = "t1"): RunRequest => ({
  kind: "reply",
  input: { inboxItemId, parts: [{ type: "typed", text }] },
});

describe("the run store (D68)", () => {
  test("a message sent during a run waits behind it, and starts when it ends", async () => {
    const h = harness();
    const a = h.store.startRun(reply("first"), { lane: "t1" });
    const b = h.store.startRun(reply("second", "t2"), { lane: "t2" });
    expect(h.store.get(a)?.state).toBe("running");
    expect(h.store.get(b)?.state).toBe("queued");
    expect(h.store.queued("t2").map((r) => r.id)).toEqual([b]);
    expect(h.store.running().map((r) => r.id)).toEqual([a, b]);
    await h.done(a);
    expect(h.store.get(a)?.state).toBe("done");
    expect(h.store.get(b)?.state).toBe("running");
  });

  test("a queued run can be withdrawn; Stop aborts a running one", async () => {
    const h = harness();
    const a = h.store.startRun(reply("first"), { lane: "t1" });
    const b = h.store.startRun(reply("second"), { lane: "t1" });
    h.store.stop(b);
    expect(h.store.get(b)).toBeUndefined();
    h.store.stop(a);
    expect(h.store.get(a)?.state).toBe("stopping");
    expect(h.pending.get(a)?.control.signal.aborted).toBe(true);
    await h.settle();
    expect(h.store.get(a)?.state).toBe("stopped");
  });

  test("Edit stops the run, takes the message back and puts the text in the composer", async () => {
    const h = harness();
    const a = h.store.startRun(reply("make it High"), { lane: "t1" });
    h.pending
      .get(a)
      ?.control.onEvent({ type: "stored", at: T0, inboxItemId: "t1", messageId: "m1" });
    expect(h.store.edit(a)).toBe("t1");
    expect(h.store.takeDraft("t1")).toEqual([{ type: "typed", text: "make it High" }]);
    expect(h.store.takeDraft("t1")).toBeNull();
    await h.settle();
    expect(h.store.get(a)?.state).toBe("stopped");
    expect(h.withdrawn).toEqual(["m1"]);
  });

  test("a new thread's Edit gives the text back to the new-thread box", async () => {
    const h = harness();
    const a = h.store.startRun(
      {
        kind: "triage",
        input: { parts: [{ type: "pasted", text: "x" }], source: "teams", senderPersonId: null },
      },
      { lane: "new" },
    );
    h.pending
      .get(a)
      ?.control.onEvent({ type: "stored", at: T0, inboxItemId: "t5", messageId: "m5" });
    expect(h.store.runFor("t5")?.id).toBe(a);
    expect(h.store.edit(a)).toBe("new");
    expect(h.store.hasDraft("new")).toBe(true);
  });

  test("a correction added while it runs is sent as a follow-up when it ends, first in line", async () => {
    const h = harness();
    const a = h.store.startRun(reply("first"), { lane: "t1" });
    h.store.startRun(reply("queued", "t2"), { lane: "t2" });
    h.store.addCorrection(a, "assign the task to me");
    h.store.addCorrection(a, "  ");
    await h.done(a);
    expect(h.started.at(-1)).toEqual(reply("assign the task to me"));
    expect(h.store.get(a)?.corrections).toEqual([]);
  });

  test("Try again now and the fast tier resolve the call's skip", async () => {
    const h = harness();
    const a = h.store.startRun(reply("first"), { lane: "t1" });
    const control = h.pending.get(a)?.control;
    const waiting = control?.skip(new AbortController().signal);
    h.store.retryNow(a, "fast");
    expect(await waiting).toEqual({ tier: "fast" });
  });

  test("resume reads again in the same record, after the run before it", async () => {
    const h = harness();
    const a = h.store.startRun(reply("first"), { lane: "t1" });
    h.pending.get(a)?.reject(new Error("timeout"));
    await h.settle();
    expect(h.store.get(a)).toMatchObject({ state: "failed", error: { message: "timeout" } });
    const again = h.store.resume("t1", { tier: "fast" });
    expect(again).toBe(a);
    expect(h.store.get(a)?.state).toBe("running");
    expect(h.started.at(-1)).toEqual({ kind: "resume", inboxItemId: "t1", tier: "fast" });
  });

  test("corrections after a stop or a failure wait in the thread's box, not sent", async () => {
    const h = harness();
    const a = h.store.startRun(reply("first"), { lane: "t1" });
    h.store.addCorrection(a, "assign it to me");
    const before = h.store.draftsVersion();
    h.store.stop(a);
    await h.settle();
    expect(h.store.get(a)?.state).toBe("stopped");
    expect(h.started).toHaveLength(1);
    expect(h.store.draftsVersion()).toBeGreaterThan(before);
    expect(h.store.takeDraft("t1")).toEqual([{ type: "typed", text: "assign it to me" }]);
    const b = h.store.startRun(reply("second"), { lane: "t1" });
    h.store.addCorrection(b, "and High");
    h.pending.get(b)?.reject(new Error("timeout"));
    await h.settle();
    expect(h.started).toHaveLength(2);
    expect(h.store.takeDraft("t1")).toEqual([{ type: "typed", text: "and High" }]);
  });

  test("a draft for a box that already holds one is added to it", () => {
    const h = harness();
    h.store.restoreQueue([
      { lane: "t1", parts: [{ type: "typed", text: "one" }] },
      { lane: "t1", parts: [{ type: "pasted", text: "two" }] },
    ]);
    expect(h.store.takeDraft("t1")).toEqual([
      { type: "typed", text: "one" },
      { type: "typed", text: "\n" },
      { type: "pasted", text: "two" },
    ]);
  });

  test("the queue is kept on every change, for a restart", async () => {
    const h = harness();
    const a = h.store.startRun(reply("first"), { lane: "t1" });
    const b = h.store.startRun(reply("second", "t2"), { lane: "t2" });
    expect(h.kept.at(-1)).toEqual([{ lane: "t2", parts: [{ type: "typed", text: "second" }] }]);
    await h.done(a);
    expect(h.store.get(b)?.state).toBe("running");
    expect(h.kept.at(-1)).toEqual([]);
  });

  test("Edit before the message is stored takes it back once it is", async () => {
    const h = harness();
    const a = h.store.startRun(reply("make it High"), { lane: "t1" });
    h.store.edit(a);
    // The message lands while the run is stopping; it is withdrawn when the run ends.
    h.pending
      .get(a)
      ?.control.onEvent({ type: "stored", at: T0, inboxItemId: "t1", messageId: "m-late" });
    await h.settle();
    expect(h.withdrawn).toEqual(["m-late"]);
  });

  test("resume of a message's turn reuses that turn's run, not the newest", async () => {
    const h = harness();
    const a = h.store.startRun(reply("first"), { lane: "t1" });
    h.pending
      .get(a)
      ?.control.onEvent({ type: "stored", at: T0, inboxItemId: "t1", messageId: "m1" });
    h.store.stop(a);
    await h.settle();
    const b = h.store.startRun(reply("second"), { lane: "t1" });
    h.pending
      .get(b)
      ?.control.onEvent({ type: "stored", at: T0, inboxItemId: "t1", messageId: "m2" });
    await h.done(b);
    expect(h.store.resume("t1", { messageId: "m1" })).toBe(a);
    expect(h.started.at(-1)).toEqual({ kind: "resume", inboxItemId: "t1", messageId: "m1" });
  });
});

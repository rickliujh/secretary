import { describe, expect, test } from "bun:test";
import { type RunRecord, revisedCards } from "@/services/intake/record";
import { applyEvent, type Run, type RunEvent, viewOf } from "@/services/intake/runs";
import type { AttemptEvent } from "@/services/llm";
import { itemsText, runCardContent, runFromRecord } from "./run-card-content";

const T0 = 5_000_000;

const base: Run = {
  id: "r1",
  lane: "t1",
  request: { kind: "triage", input: { source: "teams", senderPersonId: null } },
  state: "running",
  inboxItemId: "t1",
  messageId: "m1",
  assistantMessageId: null,
  parts: [],
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
  model: "claude-haiku-5-5",
  repair: false,
  escalated: false,
  at,
  ...extra,
});

const decide = (item: number, at: number, phase: "start" | "end" = "start"): RunEvent => ({
  type: "step",
  at,
  name: "decide",
  phase,
  title: `Deciding item ${item + 1} of 2`,
  item,
  count: 2,
  detail: item === 0 ? "the cert date" : "the Q3 numbers",
});
const done = (item: number, at: number, cards: number): RunEvent => ({
  type: "item_done",
  at,
  item,
  count: 2,
  cards,
  questions: 0,
  assistantMessageId: "a1",
});

const started: RunEvent[] = [
  { type: "stored", at: T0, inboxItemId: "t1", messageId: "m1" },
  { type: "step", at: T0, name: "lookup", phase: "start", title: "Looking up", count: 2 },
  { type: "step", at: T0 + 300, name: "lookup", phase: "end", title: "Looked up", count: 2 },
  decide(0, T0 + 300),
  { type: "attempt", at: T0 + 300, item: 0, attempt: attempt(T0 + 300, 1) },
];

const content = (events: RunEvent[], at: number, patch: Partial<Run> = {}) => {
  const run = events.reduce(applyEvent, { ...base, ...patch });
  return runCardContent(run, viewOf(run, at));
};

describe("the run card per state (mockup)", () => {
  test("running, first seconds: the plain spinner", () => {
    const c = content(started, T0 + 2000);
    expect(c.spinnerOnly).toBe(true);
    expect(c.running).toBe(true);
  });

  test("running: title, pill, time with tier and model, steps, no notices", () => {
    const c = content(started, T0 + 24_000);
    expect(c.spinnerOnly).toBe(false);
    expect(c.title).toBe("Reading your message");
    expect(c.pill).toEqual({ label: "running", tone: "run", spin: true });
    expect(c.meta).toBe("0:24 · standard · claude-haiku-5-5");
    expect(c.steps.map((s) => s.status)).toEqual(["done", "now", "pending"]);
    expect(c.notices).toEqual([]);
    expect(c.placeholder).toBeNull();
  });

  test("first item done: its cards, and a placeholder for the next", () => {
    const c = content(
      [...started, decide(0, T0 + 23_000, "end"), done(0, T0 + 23_000, 1), decide(1, T0 + 23_000)],
      T0 + 29_000,
    );
    expect(c.steps[1]?.sub).toBe("the cert date · 23 s · 1 card");
    expect(c.placeholder).toBe("Item 2's cards appear here when it is decided.");
  });

  test("slow call: try again now and the fast tier", () => {
    const c = content(started, T0 + 48_300);
    expect(c.notices).toHaveLength(1);
    expect(c.notices[0]?.tone).toBe("warn");
    expect(c.notices[0]?.text).toContain("taking long (48 s)");
    expect(c.notices[0]?.actions.map((a) => a.action)).toEqual(["retry-now", "fast-now"]);
  });

  test("retrying: the attempt and the reason, with a skip to the fast tier", () => {
    const c = content(
      [
        ...started,
        { type: "attempt", at: T0 + 120_300, item: 0, attempt: attempt(T0 + 120_300, 2) },
      ],
      T0 + 124_300,
    );
    expect(c.notices[0]).toMatchObject({
      lead: "Attempt 2 of 3.",
      text: "The last call gave no answer in time. Trying the same model again.",
    });
    expect(c.notices[0]?.actions.map((a) => a.label)).toEqual(["Skip to fast tier"]);
  });

  test("failed after three: what is kept, Try item 2 again, Fast tier, Edit, Settings", () => {
    const c = content(
      [
        ...started,
        done(0, T0 + 23_000, 1),
        decide(1, T0 + 23_000),
        {
          type: "item_failed",
          at: T0 + 383_000,
          item: 1,
          count: 2,
          message: "No response within 120s",
          kind: "timeout",
        },
      ],
      T0 + 400_000,
      {
        state: "failed",
        endedAt: T0 + 383_000,
        error: { message: "The model timed out", kind: "timeout" },
      },
    );
    expect(c.title).toBe("Could not finish");
    expect(c.pill.label).toBe("failed");
    expect(c.running).toBe(false);
    expect(c.notices[0]).toMatchObject({
      tone: "bad",
      lead: "Three attempts timed out on claude-haiku-5-5.",
      text: "Item 1's cards are kept; item 2 was not read. Your message is kept.",
    });
    expect(c.notices[0]?.actions.map((a) => a.label)).toEqual([
      "Try item 2 again",
      "Fast tier",
      "Edit message",
      "Models in Settings",
    ]);
  });

  test("stopped: Resume item 2 and Edit message", () => {
    const c = content([...started, done(0, T0 + 23_000, 1), decide(1, T0 + 23_000)], T0 + 60_000, {
      state: "stopped",
      endedAt: T0 + 31_000,
    });
    expect(c.title).toBe("Stopped");
    expect(c.notices[0]).toMatchObject({
      tone: "muted",
      text: "Stopped after 31 s. Item 1's cards are kept; nothing was proposed for item 2.",
    });
    expect(c.notices[0]?.actions.map((a) => a.label)).toEqual(["Resume item 2", "Edit message"]);
  });

  test("done: the one line", () => {
    const c = content([...started, done(0, T0 + 23_000, 1), done(1, T0 + 40_000, 2)], T0 + 60_000, {
      state: "done",
      endedAt: T0 + 41_000,
    });
    expect(c.title).toBe("Read in 41 s");
    expect(c.pill.label).toBe("done");
    expect(c.notices).toEqual([
      { tone: "ok", text: "Done in 41 s · 3 cards, 0 questions · 1 model call.", actions: [] },
    ]);
  });

  test("an unknown failure says its message", () => {
    const c = content(started, T0 + 10_000, {
      state: "failed",
      endedAt: T0 + 10_000,
      error: { message: "Something went wrong: disk full", kind: null },
    });
    expect(c.notices[0]?.lead).toBe("It could not finish.");
    expect(c.notices[0]?.text).toContain("disk full");
  });

  test("a turn stopped before a restart is read back from its record", () => {
    const record: RunRecord = {
      id: "turn-1",
      state: "running",
      kind: "read",
      messageId: "m1",
      assistantMessageId: "a1",
      instruction: null,
      source: "teams",
      undecided: [{ idx: 1, pos: 1, count: 2, quote: "q", instructions: [], ownInput: false }],
      failed: [],
      decided: 1,
      cards: 2,
      itemIds: [],
      replaced: [],
      at: new Date(T0).toISOString(),
    };
    const run = runFromRecord("t1", record, null);
    expect(run.state).toBe("stopped");
    const c = runCardContent(run, viewOf(run, T0 + 999_999));
    expect(c.notices[0]?.text).toBe(
      "Stopped part way. Item 1's cards are kept; nothing was proposed for item 2.",
    );
    expect(c.steps.map((s) => [s.status, s.sub])).toEqual([
      ["done", "2 cards"],
      ["stopped", "not read"],
    ]);
  });

  test("no fast tier bound: no button offers it", () => {
    const run = [...started].reduce(applyEvent, { ...base });
    const slow = runCardContent(run, viewOf(run, T0 + 48_300), { fastTier: false });
    expect(slow.notices[0]?.actions.map((a) => a.action)).toEqual(["retry-now"]);
    const failed = { ...run, state: "failed" as const, endedAt: T0 + 1000 };
    const c = runCardContent(failed, viewOf(failed, T0 + 2000), { fastTier: false });
    expect(c.notices[0]?.actions.map((a) => a.action)).toEqual(["retry", "edit", "settings"]);
  });

  test("the newest card offers the Resume of an earlier turn's unread items", () => {
    const c = content([...started, done(0, T0 + 23_000, 1), done(1, T0 + 40_000, 1)], T0 + 60_000, {
      state: "done",
      endedAt: T0 + 41_000,
    });
    expect(c.notices.map((n) => n.tone)).toEqual(["ok"]);
    const run = [...started, done(0, T0 + 23_000, 1)].reduce(applyEvent, {
      ...base,
      state: "done" as const,
      endedAt: T0 + 41_000,
    });
    const withUnread = runCardContent(run, viewOf(run, T0 + 60_000), { unread: 2 });
    expect(withUnread.notices.at(-1)).toEqual({
      tone: "muted",
      text: "2 items of an earlier message were not read.",
      actions: [{ action: "resume-unread", label: "Resume" }],
    });
  });

  test("a running revision locks the cards of the items it has not decided", () => {
    const record = (state: RunRecord["state"], kind: RunRecord["kind"]) => ({
      run: {
        id: "t",
        state,
        kind,
        messageId: "m",
        assistantMessageId: null,
        instruction: "High",
        source: "teams",
        undecided: [{ idx: 1, pos: 1, count: 2, quote: "q", instructions: [], ownInput: false }],
        failed: [],
        decided: 1,
        cards: 1,
        itemIds: [],
        replaced: [],
        at: "2026-11-04T09:00:00.000Z",
      },
    });
    const items = [
      { id: "i0", idx: 0 },
      { id: "i1", idx: 1 },
      { id: "i1b", idx: 1 },
    ];
    const cards = [
      { id: "a", intakeItemId: "i0", status: "pending" },
      { id: "b", intakeItemId: "i1", status: "pending" },
      { id: "c", intakeItemId: "i1b", status: "executed" },
      { id: "d", intakeItemId: "i1b", status: "pending" },
    ];
    expect([...revisedCards(record("running", "revise"), items, cards)].sort()).toEqual(["b", "d"]);
    expect(revisedCards(record("running", "read"), items, cards).size).toBe(0);
    expect(revisedCards(record("stopped", "revise"), items, cards).size).toBe(0);
  });

  test("items in words", () => {
    expect(itemsText([1], 2)).toBe("item 2");
    expect(itemsText([0, 2], 3)).toBe("items 1 and 3");
    expect(itemsText([0], 1)).toBe("the message");
  });
});

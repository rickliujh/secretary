/**
 * The intake run (FR-21, D68): a turn of the Inbox (a first message, a reply, a
 * resume or a re-triage) as a live record the thread, its list row and the
 * navigation read. One lane: runs start one after another, in the order they
 * were sent; a message sent while one runs waits behind it.
 *
 * This module holds the types, the pure reducers (`applyEvent`, `viewOf`) and
 * `createRunStore`, a module store read with `useSyncExternalStore`, outside
 * React, so a run outlives the page that started it. Running a turn is the
 * caller's (`execute`): the app wires it to `Intake` (`src/app/intake-runs.ts`).
 */
import type { AttemptEvent, LlmErrorKind, SkipRequest, Tier } from "@/services/llm";
import type { ReplyInput, TriageInput, TriageResult, TurnControl, Withdrawn } from ".";
import type { MessagePart } from "./thread";

/** The steps of a turn, in the order they run. */
export type StepName = "split" | "route" | "lookup" | "decide" | "write";

export type RunEvent =
  /** The user message is in its thread (a first message makes the thread). */
  | { type: "stored"; at: number; inboxItemId: string; messageId: string | null }
  | {
      type: "step";
      at: number;
      name: StepName;
      phase: "start" | "end";
      /** What the step says: "Split into items", "Deciding item 1 of 2". */
      title: string;
      /** The item's position in the turn, from 0, and how many the turn has. */
      item?: number;
      count?: number;
      /** A few words of the item, or what a lookup found. */
      detail?: string;
    }
  /** A model call attempt about to start; `item` while deciding one. */
  | { type: "attempt"; at: number; item?: number; attempt: AttemptEvent }
  | {
      type: "item_done";
      at: number;
      item: number;
      count: number;
      cards: number;
      questions: number;
      /** The turn's answer, which holds the item's cards. */
      assistantMessageId: string;
    }
  | {
      type: "item_failed";
      at: number;
      item: number;
      count: number;
      message: string;
      kind: LlmErrorKind | string;
    };

export type RunState = "queued" | "running" | "stopping" | "stopped" | "failed" | "done";

/** What a run does; the control (events, abort, skip) is the store's. */
export type RunRequest =
  | { kind: "triage"; input: Omit<TriageInput, keyof TurnControl> }
  | { kind: "reply"; input: Omit<ReplyInput, keyof TurnControl> }
  | { kind: "resume"; inboxItemId: string; tier?: Tier; messageId?: string | null }
  | { kind: "retriage"; inboxItemId: string };

export type Run = {
  id: string;
  /** The composer it was sent from: a thread id, or "new" for a new thread. */
  lane: string;
  request: RunRequest;
  state: RunState;
  /** Known once the message is stored (a new thread's id comes then). */
  inboxItemId: string | null;
  /** The user message the run reads; null for a re-triage. */
  messageId: string | null;
  /** The turn's answer, once its first item is written. */
  assistantMessageId: string | null;
  /** The message as sent, for the queued chip and Edit. */
  parts: readonly MessagePart[];
  events: readonly RunEvent[];
  queuedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  error: { message: string; kind: string | null } | null;
  result: TriageResult | null;
  /** Text added while it runs, sent as one follow-up reply when it ends. */
  corrections: readonly string[];
  /** Edit: once stopped, the message is taken back. */
  editing: boolean;
};

export const SLOW_CALL_MS = 30_000;
/** A plain spinner before this; the step list after (FR-21.2). */
export const CARD_AFTER_MS = 5_000;

export const ACTIVE: readonly RunState[] = ["queued", "running", "stopping"];
export const isActive = (r: Pick<Run, "state">) => ACTIVE.includes(r.state);
export const isRunning = (r: Pick<Run, "state">) => r.state === "running" || r.state === "stopping";

// ---------------------------------------------------------------------------
// Pure reducers
// ---------------------------------------------------------------------------

/** Adds an event to a run: the ids it names become the run's. */
export function applyEvent(run: Run, e: RunEvent): Run {
  const next: Run = { ...run, events: [...run.events, e] };
  if (e.type === "stored") return { ...next, inboxItemId: e.inboxItemId, messageId: e.messageId };
  if (e.type === "item_done" && !run.assistantMessageId)
    return { ...next, assistantMessageId: e.assistantMessageId };
  return next;
}

export type StepStatus = "pending" | "now" | "done" | "bad" | "stopped";

export type StepView = {
  key: string;
  name: StepName;
  title: string;
  status: StepStatus;
  /** "the cert date · 23 s · 1 card" */
  sub: string | null;
  item: number | null;
};

export type RunView = {
  state: RunState;
  title: string;
  elapsedMs: number;
  /** The plain spinner of the first seconds (FR-21.2). */
  spinnerOnly: boolean;
  tier: Tier | null;
  model: string | null;
  steps: StepView[];
  /** The call in flight, when one is. */
  call: {
    attempt: number;
    failures: number;
    of: number;
    reason: AttemptEvent["reason"];
    /** Time on this attempt so far; 0 while it waits out its pause. */
    ms: number;
    pausing: boolean;
    item: number | null;
  } | null;
  slow: boolean;
  /** "Attempt 2 of 3", while a retry is under way. */
  retrying: boolean;
  items: number | null;
  decided: number;
  failedItems: number[];
  /** Items with no cards yet that a resume would read. */
  undecided: number[];
  cards: number;
  questions: number;
  calls: number;
  repairs: number;
  /** One line for the thread list row. */
  line: string;
  /** The last failure, for the failed card. */
  failure: { message: string; kind: string | null } | null;
};

/** 0:24, 2:04 */
export const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** 0.3 s, 23 s, 2 min 4 s */
export const seconds = (ms: number) => {
  if (ms < 1000) return `${Math.max(0.1, Math.round(ms / 100) / 10)} s`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

const REASONS: Partial<Record<string, string>> = {
  timeout: "gave no answer in time",
  network: "could not reach the provider",
  rate_limit: "was rate limited",
  user: "was cut short",
};

/** Why the call is tried again, in words. */
export const reasonText = (reason: string | null) => (reason ? (REASONS[reason] ?? reason) : "");

/** The run as the card, the list row and the nav show it, at `now`. */
export function viewOf(run: Run, now: number): RunView {
  const start = run.startedAt ?? run.queuedAt;
  const end = run.endedAt ?? now;
  const elapsedMs = run.startedAt ? end - start : 0;
  const steps = new Map<string, StepView & { at: number; endAt: number | null }>();
  const keyOf = (name: StepName, item?: number) => (item === undefined ? name : `${name}:${item}`);
  let items: number | null = null;
  const done = new Map<number, { cards: number; questions: number }>();
  const failed = new Map<number, string>();
  let lastAttempt: Extract<RunEvent, { type: "attempt" }> | null = null;
  let calls = 0;
  let repairs = 0;
  let failure: RunView["failure"] = null;
  for (const e of run.events) {
    if (e.type === "step") {
      if (e.count !== undefined) items = e.count;
      const key = keyOf(e.name, e.item);
      const prev = steps.get(key);
      if (e.phase === "start") {
        steps.set(key, {
          key,
          name: e.name,
          title: e.title,
          status: "now",
          sub: e.detail ?? prev?.sub ?? null,
          item: e.item ?? null,
          at: e.at,
          endAt: null,
        });
        // A resumed item is read again: its failure is over.
        if (e.item !== undefined) failed.delete(e.item);
      } else if (prev) {
        steps.set(key, {
          ...prev,
          title: e.title,
          status: "done",
          sub: e.detail ?? prev.sub,
          endAt: e.at,
        });
      }
    } else if (e.type === "attempt") {
      lastAttempt = e;
      calls++;
      if (e.attempt.repair) repairs++;
    } else if (e.type === "item_done") {
      items = e.count;
      done.set(e.item, { cards: e.cards, questions: e.questions });
    } else if (e.type === "item_failed") {
      items = e.count;
      failed.set(e.item, e.message);
      failure = { message: e.message, kind: e.kind };
    }
  }
  if (run.error) failure = run.error;
  const ended = !isActive(run);
  // Each item's row: its time, and what it produced or why it has none.
  for (const s of steps.values()) {
    const ms = (s.endAt ?? (ended ? (run.endedAt ?? now) : now)) - s.at;
    const parts: string[] = [];
    if (s.sub) parts.push(s.sub);
    if (s.item !== null && s.name === "decide") {
      const d = done.get(s.item);
      const f = failed.get(s.item);
      if (d) {
        s.status = "done";
        parts.push(seconds(ms), plural(d.cards, "card"));
        if (d.questions) parts.push(plural(d.questions, "question"));
      } else if (f !== undefined) {
        s.status = "bad";
        parts.push(f);
      } else if (ended) {
        s.status = "stopped";
        parts.push(run.state === "done" ? seconds(ms) : "stopped");
      } else {
        if (lastAttempt && lastAttempt.item === s.item && lastAttempt.attempt.number > 1)
          parts.push(`attempt ${lastAttempt.attempt.failures + 1}`);
        parts.push(seconds(ms));
      }
    } else if (s.status === "done" || s.status === "now") {
      if (s.status === "now" && ended) s.status = run.state === "done" ? "done" : "stopped";
      parts.push(seconds(ms));
    }
    s.sub = parts.join(" · ") || null;
  }
  // Items not started yet, so the list shows the whole turn.
  const count = items ?? 0;
  for (let i = 0; i < count; i++) {
    const key = keyOf("decide", i);
    const d = done.get(i);
    if (!steps.has(key))
      steps.set(key, {
        key,
        name: "decide",
        title: count > 1 ? `Deciding item ${i + 1} of ${count}` : "Deciding",
        status: d
          ? "done"
          : failed.has(i)
            ? "bad"
            : ended && run.state !== "done"
              ? "stopped"
              : "pending",
        sub: d
          ? plural(d.cards, "card")
          : (failed.get(i) ?? (ended && run.state !== "done" ? "not read" : null)),
        item: i,
        at: Number.POSITIVE_INFINITY,
        endAt: null,
      });
  }
  const order: StepName[] = ["split", "route", "lookup", "decide", "write"];
  const list = [...steps.values()]
    .sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name) || (a.item ?? 0) - (b.item ?? 0))
    .map(({ at: _a, endAt: _e, ...s }) => s);
  // The call in flight: the last attempt while its step still runs.
  const current = lastAttempt
    ? [...steps.values()].find(
        (s) =>
          s.status === "now" &&
          (lastAttempt?.item === undefined ? s.item === null : s.item === lastAttempt?.item),
      )
    : undefined;
  const callStart = lastAttempt ? lastAttempt.at + lastAttempt.attempt.pauseMs : 0;
  const call =
    lastAttempt && current && !ended
      ? {
          attempt: lastAttempt.attempt.number,
          failures: lastAttempt.attempt.failures,
          of: lastAttempt.attempt.of,
          reason: lastAttempt.attempt.reason,
          ms: Math.max(0, now - callStart),
          pausing: now < callStart,
          item: lastAttempt.item ?? null,
        }
      : null;
  const cards = [...done.values()].reduce((n, d) => n + d.cards, 0);
  const questions = [...done.values()].reduce((n, d) => n + d.questions, 0);
  const undecided = Array.from({ length: count }, (_, i) => i).filter((i) => !done.has(i));
  const slow = !!call && !call.pausing && call.ms >= SLOW_CALL_MS;
  const retrying = !!call && call.failures > 0;
  const nowStep = list.find((s) => s.status === "now");
  const kept = cards ? `${plural(cards, "card")} kept` : "nothing kept";
  const line =
    run.state === "queued"
      ? "Queued"
      : run.state === "stopping"
        ? "Stopping"
        : run.state === "done"
          ? cards + questions
            ? `${plural(cards, "card")}${questions ? `, ${plural(questions, "question")}` : ""} waiting`
            : "Nothing to do"
          : run.state === "failed"
            ? `Failed · ${kept}`
            : run.state === "stopped"
              ? `Stopped · ${kept}`
              : slow
                ? `Slow call · ${clock(elapsedMs)}`
                : retrying && call
                  ? `Attempt ${call.failures + 1} of ${call.of} · ${clock(elapsedMs)}`
                  : `${nowStep?.title ?? "Reading"}${cards ? ` · ${plural(cards, "card")} so far` : ` · ${clock(elapsedMs)}`}`;
  const title =
    run.state === "done"
      ? `Read in ${seconds(elapsedMs)}`
      : run.state === "failed"
        ? "Could not finish"
        : run.state === "stopped"
          ? "Stopped"
          : run.state === "queued"
            ? "Waiting for the run before it"
            : run.request.kind === "reply"
              ? "Reading your reply"
              : "Reading your message";
  return {
    state: run.state,
    title,
    elapsedMs,
    spinnerOnly: run.state === "running" && elapsedMs < CARD_AFTER_MS,
    tier: lastAttempt?.attempt.tier ?? null,
    model: lastAttempt?.attempt.model ?? null,
    steps: list,
    call,
    slow,
    retrying,
    items,
    decided: done.size,
    failedItems: [...failed.keys()].sort((a, b) => a - b),
    undecided,
    cards,
    questions,
    calls,
    repairs,
    line,
    failure,
  };
}

/** The done line: "Done in 41 s · 3 cards, 0 questions · 2 model calls (1 repair)". */
export const doneLine = (v: RunView) =>
  `Done in ${seconds(v.elapsedMs)} · ${plural(v.cards, "card")}, ${plural(v.questions, "question")} · ${plural(v.calls, "model call")}${v.repairs ? ` (${plural(v.repairs, "repair")})` : ""}`;

/** The run to start next: the first queued one, when none runs (one lane, FIFO). */
export function nextToStart(runs: readonly Run[]): Run | null {
  if (runs.some(isRunning)) return null;
  return runs.find((r) => r.state === "queued") ?? null;
}

/** The corrections added while a run ran, as one typed message (FR-21.3). */
const correctionParts = (run: Run): MessagePart[] | null => {
  const text = run.corrections.map((c) => c.trim()).filter(Boolean);
  return text.length ? [{ type: "typed", text: text.join("\n") }] : null;
};

/**
 * A follow-up reply from the corrections, sent only after a run that finished;
 * after a stop or a failure they wait in the thread's composer (`correctionDraft`).
 */
export function correctionRequest(run: Run): RunRequest | null {
  const parts = correctionParts(run);
  if (!parts || !run.inboxItemId || run.editing || run.state !== "done") return null;
  return { kind: "reply", input: { inboxItemId: run.inboxItemId, parts } };
}

/** Corrections of a run that stopped or failed: a draft for the thread's composer. */
export function correctionDraft(run: Run): { lane: string; parts: MessagePart[] } | null {
  const parts = correctionParts(run);
  if (!parts || !run.inboxItemId || run.editing || run.state === "done") return null;
  return { lane: run.inboxItemId, parts };
}

/** A queued message as kept across a restart (D68): it comes back as a draft, not a run. */
export type QueuedMessage = { lane: string; parts: MessagePart[] };

/** The `sync_state` key of the queue kept across a restart. */
export const QUEUE_KEY = "inbox.queue";

/** The thread a request is about, when it is known before it runs. */
export const threadOf = (r: RunRequest): string | null =>
  r.kind === "triage" ? null : r.kind === "reply" ? r.input.inboxItemId : r.inboxItemId;

/** The parts a request carries, for the queued chip and Edit. */
export const partsOfRequest = (r: RunRequest): MessagePart[] =>
  r.kind === "triage" || r.kind === "reply"
    ? r.input.parts
      ? [...r.input.parts]
      : [
          ...(r.input.text ? [{ type: "pasted" as const, text: r.input.text }] : []),
          ...(r.input.instruction ? [{ type: "typed" as const, text: r.input.instruction }] : []),
        ]
    : [];

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export type RunControl = {
  signal: AbortSignal;
  onEvent: (e: RunEvent) => void;
  skip: (signal: AbortSignal) => Promise<SkipRequest>;
};

export type RunStoreDeps = {
  /** Runs the turn; rejects when stopped (the signal) or failed. */
  execute: (run: Run, control: RunControl) => Promise<TriageResult>;
  /** Edit: takes the stopped run's message back. */
  withdraw: (messageId: string) => Promise<Withdrawn>;
  /** A rejection that is a stop, not a failure. */
  isStop?: (error: unknown) => boolean;
  /** The failure's message and kind, for the card. */
  describe?: (error: unknown) => { message: string; kind: string | null };
  /** After every event and state change of a run: refresh what shows it. */
  onChange?: (run: Run, e?: RunEvent) => void;
  /** When a run ends, however it ends. */
  onEnd?: (run: Run) => void;
  /** Edit could not take the message back. */
  onWithdrawError?: (run: Run, error: unknown) => void;
  /** The queued messages changed: keep them across a restart (D68). */
  onQueue?: (queued: QueuedMessage[]) => void;
  now?: () => number;
  newId?: () => string;
};

/** Finished runs kept for their cards' done line and failure. */
const KEEP_FINISHED = 30;

const findLast = <T>(list: readonly T[], f: (x: T) => boolean): T | undefined => {
  for (let i = list.length - 1; i >= 0; i--) {
    const x = list[i] as T;
    if (f(x)) return x;
  }
  return undefined;
};

export type RunStore = ReturnType<typeof createRunStore>;

export function createRunStore(deps: RunStoreDeps) {
  const now = deps.now ?? Date.now;
  let counter = 0;
  const newId = deps.newId ?? (() => `run-${now()}-${++counter}`);
  let runs: readonly Run[] = [];
  const drafts = new Map<string, MessagePart[]>();
  // Bumped with every draft change, so a composer re-reads (`draftsVersion`).
  let draftsVersion = 0;
  const setDraft = (lane: string, parts: readonly MessagePart[]) => {
    const before = drafts.get(lane);
    // Two drafts for one box are joined, never one lost.
    drafts.set(
      lane,
      before?.length ? [...before, { type: "typed", text: "\n" }, ...parts] : [...parts],
    );
    draftsVersion++;
  };
  let queueKept = "[]";
  const listeners = new Set<() => void>();
  const controllers = new Map<string, AbortController>();
  const skips = new Map<string, Set<(s: SkipRequest) => void>>();

  const emit = () => {
    const queued: QueuedMessage[] = runs
      .filter((r) => r.state === "queued" && r.parts.length)
      .map((r) => ({ lane: r.lane, parts: [...r.parts] }));
    const json = JSON.stringify(queued);
    if (json !== queueKept) {
      queueKept = json;
      deps.onQueue?.(queued);
    }
    for (const l of listeners) l();
  };
  const get = (id: string) => runs.find((r) => r.id === id);
  const update = (id: string, f: (r: Run) => Run, e?: RunEvent) => {
    const current = get(id);
    if (!current) return;
    const next = f(current);
    runs = runs.map((r) => (r.id === id ? next : r));
    emit();
    deps.onChange?.(next, e);
  };
  const remove = (id: string) => {
    runs = runs.filter((r) => r.id !== id);
    emit();
  };
  const trim = () => {
    const finished = runs.filter((r) => !isActive(r));
    if (finished.length <= KEEP_FINISHED) return;
    const drop = new Set(finished.slice(0, finished.length - KEEP_FINISHED).map((r) => r.id));
    runs = runs.filter((r) => !drop.has(r.id));
  };

  const finish = (id: string, patch: Partial<Run>) => {
    controllers.delete(id);
    skips.delete(id);
    update(id, (r) => ({ ...r, ...patch, endedAt: now() }));
    const run = get(id);
    if (run) {
      deps.onEnd?.(run);
      if (run.editing && run.messageId) {
        const messageId = run.messageId;
        deps.withdraw(messageId).catch((e) => deps.onWithdrawError?.(run, e));
      }
      // The corrections go first, before anything queued after the run (FR-21.3);
      // after a stop or a failure they wait in the thread's box instead.
      const follow = correctionRequest(run);
      const draft = correctionDraft(run);
      if (follow) {
        update(id, (r) => ({ ...r, corrections: [] }));
        enqueue(follow, { lane: run.lane, front: true });
      } else if (draft) {
        setDraft(draft.lane, draft.parts);
        update(id, (r) => ({ ...r, corrections: [] }));
      }
    }
    trim();
    pump();
  };

  const begin = (run: Run) => {
    const controller = new AbortController();
    controllers.set(run.id, controller);
    update(run.id, (r) => ({
      ...r,
      state: "running",
      startedAt: now(),
      endedAt: null,
      error: null,
    }));
    const started = get(run.id) ?? run;
    const control: RunControl = {
      signal: controller.signal,
      onEvent: (e) => {
        update(run.id, (r) => applyEvent(r, e), e);
        // Edit before the message was stored: it is taken back once it is.
        const now = get(run.id);
        if (e.type === "stored" && e.messageId && now?.editing && !isActive(now))
          deps.withdraw(e.messageId).catch((err) => deps.onWithdrawError?.(now, err));
      },
      skip: (signal) =>
        new Promise<SkipRequest>((resolve) => {
          const set = skips.get(run.id) ?? new Set();
          skips.set(run.id, set);
          set.add(resolve);
          signal.addEventListener("abort", () => set.delete(resolve));
        }),
    };
    deps.execute(started, control).then(
      (result) => finish(run.id, { state: "done", result }),
      (error) => {
        const stopped = controller.signal.aborted || deps.isStop?.(error);
        finish(
          run.id,
          stopped
            ? { state: "stopped" }
            : {
                state: "failed",
                error: deps.describe?.(error) ?? {
                  message: error instanceof Error ? error.message : String(error),
                  kind: null,
                },
              },
        );
      },
    );
  };

  const pump = () => {
    const next = nextToStart(runs);
    if (next) begin(next);
  };

  const enqueue = (
    request: RunRequest,
    opts: { lane: string; front?: boolean; reuse?: string; messageId?: string | null },
  ) => {
    const existing = opts.reuse ? get(opts.reuse) : undefined;
    const id = existing?.id ?? newId();
    const run: Run = {
      id,
      lane: opts.lane,
      request,
      state: "queued",
      inboxItemId: existing?.inboxItemId ?? threadOf(request),
      messageId: existing?.messageId ?? opts.messageId ?? null,
      assistantMessageId: existing?.assistantMessageId ?? null,
      parts: existing?.parts ?? partsOfRequest(request),
      events: existing?.events ?? [],
      queuedAt: now(),
      startedAt: existing?.startedAt ?? null,
      endedAt: null,
      error: null,
      result: null,
      corrections: [],
      editing: false,
    };
    const rest = runs.filter((r) => r.id !== id);
    if (opts.front) {
      const at = rest.findIndex((r) => r.state === "queued");
      runs = at < 0 ? [...rest, run] : [...rest.slice(0, at), run, ...rest.slice(at)];
    } else runs = [...rest, run];
    emit();
    deps.onChange?.(run);
    pump();
    return id;
  };

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Every run, oldest first; a new array after each change. */
    snapshot: () => runs,
    get,
    /** Sends a turn: it starts now, or waits behind the run going (one lane). */
    startRun: (request: RunRequest, opts: { lane: string }) => enqueue(request, opts),
    /** The runs waiting in a composer's lane. */
    queued: (lane: string) => runs.filter((r) => r.state === "queued" && r.lane === lane),
    /** The thread's newest run: the active one first. */
    runFor: (inboxItemId: string) =>
      findLast(runs, (r) => r.inboxItemId === inboxItemId && isRunning(r)) ??
      findLast(runs, (r) => r.inboxItemId === inboxItemId && r.state !== "queued") ??
      null,
    /** Runs going or waiting, for the nav. */
    running: () => runs.filter(isActive),
    /** Stops a run: a queued one is taken out; a running one's calls are aborted. */
    stop(id: string) {
      const run = get(id);
      if (!run) return;
      if (run.state === "queued") return remove(id);
      if (run.state !== "running") return;
      update(id, (r) => ({ ...r, state: "stopping" }));
      controllers.get(id)?.abort();
    },
    /**
     * Edit (FR-21.3): a queued run is taken out; a running one stops and its
     * message is taken back. Either way its text goes back to its composer.
     */
    edit(id: string, opts: { lane?: string; parts?: readonly MessagePart[] } = {}) {
      const run = get(id);
      if (!run) return null;
      const lane =
        opts.lane ?? (run.request.kind === "triage" ? run.lane : (run.inboxItemId ?? run.lane));
      setDraft(lane, run.parts.length ? run.parts : (opts.parts ?? []));
      if (run.state === "queued") remove(id);
      else if (isRunning(run)) {
        update(id, (r) => ({ ...r, editing: true, state: "stopping" }));
        controllers.get(id)?.abort();
      } else if (run.messageId) {
        const messageId = run.messageId;
        update(id, (r) => ({ ...r, editing: true }));
        deps.withdraw(messageId).catch((e) => deps.onWithdrawError?.(run, e));
      }
      emit();
      return lane;
    },
    /**
     * Edit of a message whose run the store no longer holds (a turn stopped
     * before the app restarted): it is taken back, its text goes to `lane`.
     */
    withdrawMessage(messageId: string, opts: { lane: string; parts: readonly MessagePart[] }) {
      setDraft(opts.lane, opts.parts);
      emit();
      return deps.withdraw(messageId);
    },
    /**
     * Reads the items a stopped or failed turn left undecided (D68), in the same
     * run record when the store still has it; `tier` for the fast-tier button.
     */
    resume(inboxItemId: string, opts: { tier?: Tier; messageId?: string | null } = {}) {
      // The run of the turn it resumes, when the store still has it.
      const previous = findLast(
        runs,
        (r) =>
          r.inboxItemId === inboxItemId &&
          (opts.messageId === undefined || r.messageId === opts.messageId),
      );
      const reuse = previous && !isActive(previous) ? previous.id : undefined;
      return enqueue(
        {
          kind: "resume",
          inboxItemId,
          ...(opts.tier ? { tier: opts.tier } : {}),
          ...(opts.messageId !== undefined ? { messageId: opts.messageId } : {}),
        },
        { lane: previous?.lane ?? inboxItemId, reuse, messageId: opts.messageId ?? null },
      );
    },
    /** "Try again now", "Use the fast tier": the call in flight gives way (D68). */
    retryNow(id: string, tier?: Tier) {
      const waiting = skips.get(id);
      if (!waiting) return;
      skips.set(id, new Set());
      for (const resolve of waiting) resolve(tier ? { tier } : {});
    },
    /** A correction typed into the run card, sent when the run ends (FR-21.3). */
    addCorrection(id: string, text: string) {
      if (!text.trim()) return;
      update(id, (r) => ({ ...r, corrections: [...r.corrections, text.trim()] }));
    },
    /** Text Edit gave back to a composer; taken once. */
    takeDraft(lane: string) {
      const parts = drafts.get(lane) ?? null;
      if (drafts.delete(lane)) draftsVersion++;
      return parts;
    },
    hasDraft: (lane: string) => drafts.has(lane),
    /** Changes with every draft, for `useSyncExternalStore`. */
    draftsVersion: () => draftsVersion,
    /** Queued messages kept from before a restart come back as drafts (D68). */
    restoreQueue(list: readonly QueuedMessage[]) {
      for (const q of list) if (q.parts.length) setDraft(q.lane, q.parts);
      if (list.length) emit();
    },
  };
}

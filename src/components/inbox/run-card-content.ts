/**
 * What the run card shows in each state (FR-21, D68, docs/intake-run-mockup.html),
 * as a pure mapping from the run's view, so it is testable without a DOM.
 */
import type { RunRecord } from "@/services/intake/record";
import {
  clock,
  doneLine,
  type Run,
  type RunEvent,
  type RunView,
  reasonText,
  type StepView,
  seconds,
} from "@/services/intake/runs";

/**
 * A turn the store no longer holds (the app restarted) as the run the card
 * shows: stopped or failed, what it kept, Resume (D68).
 */
export function runFromRecord(inboxItemId: string, record: RunRecord, error: string | null): Run {
  const at = Date.parse(record.at) || 0;
  const count = record.undecided[0]?.count ?? record.decided + record.undecided.length;
  const left = new Set(record.undecided.map((j) => j.pos));
  const failed = new Set(record.failed);
  const events: RunEvent[] = [];
  let first = true;
  for (let i = 0; i < count; i++) {
    if (failed.has(i))
      events.push({
        type: "item_failed",
        at,
        item: i,
        count,
        message: error ?? "Could not be read",
        kind: "",
      });
    else if (!left.has(i)) {
      // The record keeps the turn's cards, not each item's: the count goes on the first.
      events.push({
        type: "item_done",
        at,
        item: i,
        count,
        cards: first ? record.cards : 0,
        questions: 0,
        assistantMessageId: record.assistantMessageId ?? "",
      });
      first = false;
    }
  }
  const state = record.state === "failed" ? "failed" : "stopped";
  return {
    id: `record:${inboxItemId}:${record.id || record.messageId || "turn"}`,
    lane: inboxItemId,
    request: { kind: "resume", inboxItemId },
    state,
    inboxItemId,
    messageId: record.messageId,
    assistantMessageId: record.assistantMessageId,
    parts: [],
    events,
    queuedAt: at,
    startedAt: at,
    endedAt: at,
    error: state === "failed" ? { message: error ?? "It could not finish", kind: null } : null,
    result: null,
    corrections: [],
    editing: false,
  };
}

export type CardAction =
  | "retry-now"
  | "fast-now"
  | "retry"
  | "fast"
  | "resume"
  | "resume-unread"
  | "edit"
  | "settings";

export type Notice = {
  tone: "warn" | "bad" | "muted" | "ok";
  /** Bold lead, then the sentence. */
  lead?: string;
  text: string;
  actions: { action: CardAction; label: string; primary?: boolean }[];
};

export type RunCardContent = {
  /** The plain spinner of the first seconds (FR-21.2): no card yet. */
  spinnerOnly: boolean;
  title: string;
  pill: { label: string; tone: "run" | "ok" | "bad" | "muted"; spin: boolean };
  /** "0:24 · standard · claude-haiku-5-5" */
  meta: string;
  steps: StepView[];
  notices: Notice[];
  /** Stop in the header, the correction box and the next item's placeholder while it runs. */
  running: boolean;
  /** "Item 2's cards appear here when it is decided." */
  placeholder: string | null;
};

/** "item 2", "items 1 and 3", "the message" for a turn of one item. */
export const itemsText = (positions: readonly number[], count: number | null) => {
  if (!count || count <= 1) return "the message";
  const n = positions.map((p) => p + 1);
  if (n.length === 1) return `item ${n[0]}`;
  return `items ${n.slice(0, -1).join(", ")} and ${n.at(-1)}`;
};

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Why it failed, in the words of the mockup. */
const failureLead = (v: RunView) => {
  const kind = v.failure?.kind;
  const on = v.model ? ` on ${v.model}` : "";
  if (kind === "timeout") return `Three attempts timed out${on}`;
  if (kind === "network") return `Three attempts could not reach the provider${on}`;
  if (kind === "rate_limit") return `Rate limited three times${on}`;
  if (kind === "auth" || kind === "config") return "The model is not available";
  return null;
};

/**
 * What is kept and what is not: "Item 1's cards are kept; item 2 was not read."
 * (failed), "...; nothing was proposed for item 2." (stopped).
 */
const keptText = (v: RunView, stopped: boolean) => {
  const done = Array.from({ length: v.items ?? 0 }, (_, i) => i).filter(
    (i) => !v.undecided.includes(i),
  );
  if (v.cards === 0) return "Nothing was written.";
  const left = v.undecided.length ? itemsText(v.undecided, v.items) : null;
  const rest = left
    ? stopped
      ? `; nothing was proposed for ${left}`
      : `; ${left} was not read`
    : "";
  return `${capital(itemsText(done, v.items))}'s cards are kept${rest}.`;
};

export type CardOptions = {
  /** The fast tier is bound in Settings; without it no fast-tier button shows. */
  fastTier?: boolean;
  /**
   * Items an earlier turn of the thread left unread (D68), when this is the
   * thread's newest card: it offers their Resume.
   */
  unread?: number;
};

export function runCardContent(run: Run, v: RunView, opts: CardOptions = {}): RunCardContent {
  const running = run.state === "running" || run.state === "stopping";
  const meta = [v.elapsedMs > 0 ? clock(v.elapsedMs) : null, v.tier, v.model]
    .filter(Boolean)
    .join(" · ");
  const notices: Notice[] = [];
  if (running && v.slow && v.call)
    notices.push({
      tone: "warn",
      text: `This call is taking long (${Math.round(v.call.ms / 1000)} s). When it runs out of time I try again, up to three attempts in all.`,
      actions: [
        { action: "retry-now", label: "Try again now" },
        { action: "fast-now", label: "Use the fast tier" },
      ],
    });
  else if (running && v.retrying && v.call)
    notices.push({
      tone: "warn",
      lead: `Attempt ${v.call.failures + 1} of ${v.call.of}.`,
      text: `The last call ${reasonText(v.call.reason)}. ${v.call.pausing ? "Trying the same model again in a moment." : "Trying the same model again."}`,
      actions: [{ action: "fast-now", label: "Skip to fast tier" }],
    });
  const undecided = v.undecided.length ? itemsText(v.undecided, v.items) : null;
  if (run.state === "failed")
    notices.push({
      tone: "bad",
      lead: `${failureLead(v) ?? "It could not finish"}.`,
      // An error the lead does not name is said as it is.
      text: [
        failureLead(v) ? null : v.failure?.message,
        v.items ? keptText(v, false) : null,
        "Your message is kept.",
      ]
        .filter(Boolean)
        .join(" "),
      actions: [
        {
          action: "retry",
          label: undecided && v.items && v.items > 1 ? `Try ${undecided} again` : "Try again",
          primary: true,
        },
        { action: "fast", label: "Fast tier" },
        ...(run.messageId ? [{ action: "edit" as const, label: "Edit message" }] : []),
        { action: "settings", label: "Models in Settings" },
      ],
    });
  if (run.state === "stopped")
    notices.push({
      tone: "muted",
      // A turn read back after a restart has no time of its own.
      text: `${v.elapsedMs > 0 ? `Stopped after ${seconds(v.elapsedMs)}.` : "Stopped part way."}${v.items ? ` ${keptText(v, true)}` : ""}`,
      actions: [
        {
          action: "resume",
          label: undecided && v.items && v.items > 1 ? `Resume ${undecided}` : "Resume",
        },
        ...(run.messageId ? [{ action: "edit" as const, label: "Edit message" }] : []),
      ],
    });
  if (run.state === "done") notices.push({ tone: "ok", text: `${doneLine(v)}.`, actions: [] });
  if (!running && run.state !== "queued" && opts.unread)
    notices.push({
      tone: "muted",
      text: `${opts.unread === 1 ? "1 item" : `${opts.unread} items`} of an earlier message ${opts.unread === 1 ? "was" : "were"} not read.`,
      actions: [{ action: "resume-unread", label: "Resume" }],
    });
  // No fast tier bound: no button offers it.
  if (opts.fastTier === false)
    for (const n of notices)
      n.actions = n.actions.filter((a) => a.action !== "fast" && a.action !== "fast-now");
  const next = running ? v.steps.find((s) => s.name === "decide" && s.status !== "done") : null;
  return {
    spinnerOnly: v.spinnerOnly,
    title: v.title,
    pill:
      run.state === "done"
        ? { label: "done", tone: "ok", spin: false }
        : run.state === "failed"
          ? { label: "failed", tone: "bad", spin: false }
          : run.state === "stopped"
            ? { label: "stopped", tone: "muted", spin: false }
            : run.state === "stopping"
              ? { label: "stopping", tone: "muted", spin: true }
              : run.state === "queued"
                ? { label: "queued", tone: "muted", spin: false }
                : { label: "running", tone: "run", spin: true },
    meta,
    steps: v.steps,
    notices,
    running,
    placeholder:
      next && next.item !== null && v.decided > 0
        ? `${capital(itemsText([next.item], v.items))}'s cards appear here when it is decided.`
        : null,
  };
}

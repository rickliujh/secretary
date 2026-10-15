/**
 * The sweep (FR-12.3, D49): a keyboard pass over what needs a decision, in a
 * fixed order. Pure; the dialog steps through `sweepItems` and reports with
 * `sweepSummary`.
 */
import { daysBetween, localDateOf } from "@/lib/dates";
import type { TicketRow, Today, WaitRow } from "./today";

/** `sync_state` key: when the weekly pass over untouched asks last ran. */
export const SWEEP_STALE_KEY = "sweep.staleAt";
/** An ask nobody touched for this many days comes up in the weekly pass. */
export const STALE_ASK_DAYS = 14;
/** The pass over untouched asks runs at most once in this many days. */
export const STALE_PASS_DAYS = 7;

export type SweepWhy = "woken" | "followup" | "back" | "ask_due" | "ask_stale";

export type SweepItem =
  | { id: string; why: "woken" | "ask_due" | "ask_stale"; row: TicketRow }
  | { id: string; why: "followup" | "back"; row: WaitRow };

/** Whether the weekly pass over untouched asks is due. */
export function stalePassDue(staleAt: string | null | undefined, now: Date): boolean {
  if (!staleAt || Number.isNaN(Date.parse(staleAt))) return true;
  return now.getTime() - Date.parse(staleAt) >= STALE_PASS_DAYS * 86_400_000;
}

/**
 * What the sweep steps through, in order: woken tickets, follow-ups due or
 * overdue (unless the next chase is set for a later day), owners back, small
 * asks due or overdue (soonest due first) and, when the weekly pass is due,
 * small asks nobody touched for 14 days (oldest first). Each item once. Only what Today lists: snoozed tickets and sleeping
 * waits stay out.
 */
export function sweepItems(t: Today, today: string, opts: { stale: boolean }): SweepItem[] {
  const tickets = t.yourMove.filter((r): r is TicketRow => r.kind !== "thread");
  const waits = t.theirMove.filter((r): r is WaitRow => r.kind === "wait");
  const asks = tickets.filter((r) => r.kind === "ask");
  const items: SweepItem[] = [
    ...tickets
      .filter((r) => r.kind === "woken")
      .map((row) => ({ id: row.issue.key, why: "woken" as const, row })),
    // An overdue wait whose next chase is already set for a later day was
    // decided on; it comes back on that day as a follow-up due.
    ...waits
      .filter((w) => w.state === "followup" || (w.state === "overdue" && !w.decided))
      .map((row) => ({ id: `wait:${row.dependency.id}`, why: "followup" as const, row })),
    ...waits
      .filter((w) => w.state === "back")
      .map((row) => ({ id: `wait:${row.dependency.id}`, why: "back" as const, row })),
    ...asks
      .filter((r) => !!r.issue.dueDate && daysBetween(today, r.issue.dueDate) <= 0)
      .sort((a, b) => (a.issue.dueDate ?? "").localeCompare(b.issue.dueDate ?? ""))
      .map((row) => ({ id: row.issue.key, why: "ask_due" as const, row })),
  ];
  if (opts.stale) {
    const seen = new Set(items.map((i) => i.id));
    items.push(
      ...asks
        .filter(
          (r) =>
            !seen.has(r.issue.key) &&
            daysBetween(localDateOf(r.issue.updated), today) >= STALE_ASK_DAYS,
        )
        .sort((a, b) => a.issue.updated.localeCompare(b.issue.updated))
        .map((row) => ({ id: row.issue.key, why: "ask_stale" as const, row })),
    );
  }
  return items;
}

/** Why an item is in the sweep, as its heading says. */
export const SWEEP_WHY: Record<SweepWhy, string> = {
  woken: "Woke up",
  followup: "Follow-up due",
  back: "Owner is back",
  ask_due: "Ask due",
  ask_stale: "Untouched for 14 days",
};

export type SweepOutcome = "done" | "nudged" | "snoozed" | "dropped" | "skipped";

const OUTCOME_WORDS: Record<SweepOutcome, string> = {
  done: "done",
  nudged: "nudged",
  snoozed: "snoozed",
  dropped: "dropped",
  skipped: "skipped",
};

/** "2 done, 1 nudged, 3 skipped"; items not reached are "left". */
export function sweepSummary(outcomes: readonly SweepOutcome[], total: number): string {
  const counts = new Map<SweepOutcome, number>();
  for (const o of outcomes) counts.set(o, (counts.get(o) ?? 0) + 1);
  const parts = (Object.keys(OUTCOME_WORDS) as SweepOutcome[])
    .filter((o) => counts.get(o))
    .map((o) => `${counts.get(o)} ${OUTCOME_WORDS[o]}`);
  const left = total - outcomes.length;
  if (left > 0) parts.push(`${left} left`);
  return parts.length ? parts.join(", ") : "Nothing to sweep";
}

// ---------------------------------------------------------------------------
// The sweep dialog's session, pure so the guards are tested: one action at a
// time, outcomes recorded by item id, and a short settle after each step.
// ---------------------------------------------------------------------------

export type SweepMode = "idle" | "done" | "snooze" | "drop";

/**
 * After the shown item changes, actions on it are ignored this long, so the
 * second click of a double-click (or a second key press) on the previous item
 * does not land on the next one.
 */
export const SWEEP_SETTLE_MS = 400;

export type SweepSession = {
  readonly ids: readonly string[];
  /** What was done to each item, by id. */
  readonly outcomes: Readonly<Record<string, SweepOutcome>>;
  /** The item shown. */
  readonly index: number;
  readonly mode: SweepMode;
  /** The item an action is running on; no other action starts meanwhile. */
  readonly busy: string | null;
  /** When the shown item came up (ms). */
  readonly shownAt: number;
};

export const startSweep = (ids: readonly string[], now: number): SweepSession => ({
  ids,
  outcomes: {},
  index: 0,
  mode: "idle",
  busy: null,
  shownAt: now,
});

/** The id of the item shown; null once the sweep reached its summary. */
export const shownId = (s: SweepSession): string | null => s.ids[s.index] ?? null;

export const sweepFinished = (s: SweepSession) => s.index >= s.ids.length;

/** The outcomes so far, in the sweep's order, for `sweepSummary`. */
export const sweepOutcomes = (s: SweepSession): SweepOutcome[] =>
  s.ids.flatMap((id) => {
    const o = s.outcomes[id];
    return o ? [o] : [];
  });

/**
 * Whether an action on `id` may start at `now`: nothing else is running, the
 * item was not decided already (a skipped one may still be, from a Retry),
 * and the shown item has been shown for `SWEEP_SETTLE_MS`.
 */
export function canAct(s: SweepSession, id: string, now: number): boolean {
  if (s.busy !== null || !s.ids.includes(id)) return false;
  const done = s.outcomes[id];
  if (done && done !== "skipped") return false;
  return id !== shownId(s) || now - s.shownAt >= SWEEP_SETTLE_MS;
}

/** Starts an action on `id`; null when `canAct` says no, and the caller does nothing. */
export const beginAction = (s: SweepSession, id: string, now: number): SweepSession | null =>
  canAct(s, id, now) ? { ...s, busy: id } : null;

/**
 * The action on `id` ended without a decision (it failed, or it offers a
 * choice first): the same item stays, optionally in another mode.
 */
export function releaseAction(s: SweepSession, id: string, mode?: SweepMode): SweepSession {
  if (s.busy !== id) return s;
  return { ...s, busy: null, mode: mode ?? s.mode };
}

/**
 * Records what was done to `id`. The sweep moves on only when `id` is the item
 * shown, so a late or repeated success never skips or labels another item.
 */
export function settleAction(
  s: SweepSession,
  id: string,
  outcome: SweepOutcome,
  now: number,
): SweepSession {
  const at = s.ids.indexOf(id);
  if (at < 0) return s;
  const next = {
    ...s,
    outcomes: { ...s.outcomes, [id]: outcome },
    busy: s.busy === id ? null : s.busy,
  };
  return at === s.index ? { ...next, index: at + 1, mode: "idle", shownAt: now } : next;
}

/** Space: the shown item is skipped, under the same guard as any action. */
export const skipShown = (s: SweepSession, now: number): SweepSession => {
  const id = shownId(s);
  return id && canAct(s, id, now) ? settleAction(s, id, "skipped", now) : s;
};

/** Opens a choice (S, X) or goes back (Esc); not while an action runs or the item settles. */
export function changeMode(s: SweepSession, mode: SweepMode, now: number): SweepSession {
  if (s.busy !== null) return s;
  if (mode === "idle") return s.mode === "idle" ? s : { ...s, mode };
  const id = shownId(s);
  return id && canAct(s, id, now) ? { ...s, mode } : s;
}

type KeyLike = {
  key: string;
  repeat: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
};

export type SweepCommand =
  | { do: "done" | "nudge" | "snooze" | "drop" | "skip" }
  | { do: "pick"; n: number };

const LETTERS: Record<string, SweepCommand> = {
  d: { do: "done" },
  n: { do: "nudge" },
  s: { do: "snooze" },
  x: { do: "drop" },
  " ": { do: "skip" },
};

/**
 * What a key press in the sweep means; null when it is not a command. Keys act
 * only with focus on the sweep's own body (`onBody`), never on a button, link
 * or field, where Space and Enter press or type as usual; a held key's
 * auto-repeat never acts.
 */
export function sweepKey(e: KeyLike, mode: SweepMode, onBody: boolean): SweepCommand | null {
  if (e.repeat || !onBody || e.ctrlKey || e.metaKey || e.altKey) return null;
  if (mode === "done" || mode === "snooze")
    return /^[1-9]$/.test(e.key) ? { do: "pick", n: Number(e.key) - 1 } : null;
  if (mode !== "idle") return null;
  return LETTERS[e.key.toLowerCase()] ?? null;
}

/** Enter in the drop reason drops (Shift+Enter is a new line); a held Enter does not repeat it. */
export const submitsReason = (e: KeyLike & { shiftKey: boolean; isComposing?: boolean }) =>
  e.key === "Enter" && !e.shiftKey && !e.repeat && !e.isComposing;

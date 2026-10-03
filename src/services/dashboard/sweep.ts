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
      .filter(
        (w) =>
          w.state === "followup" ||
          (w.state === "overdue" &&
            (w.timing.followupDue || !w.timing.followupOn || w.timing.followupOn <= today)),
      )
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

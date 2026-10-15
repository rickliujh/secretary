/**
 * Pure rules for Today's row actions (D49): which Jira transition finishes a
 * ticket, which one drops it (D43), and the snooze presets.
 */
import { addBusinessDays, daysBetween, isRealDate } from "@/lib/dates";
import { isCancelStatus } from "@/services/jira/cancel";
import type { Transition } from "@/services/jira/schemas";

/** A status name that means finished, for transitions Jira returns without a category. */
const DONE_NAME = /^(done|closed|resolved|complete(d)?|finished)$/i;

const toDone = (t: Transition) =>
  t.to.statusCategory ? t.to.statusCategory.key === "done" : DONE_NAME.test(t.to.name.trim());

/**
 * Transitions that finish a ticket: into a done-category status that is not a
 * cancel-like one. More than one means the user picks (a menu).
 */
export function doneTransitions(transitions: readonly Transition[]): Transition[] {
  return transitions.filter(
    (t) => toDone(t) && !isCancelStatus(t.to.name) && !isCancelStatus(t.name),
  );
}

/**
 * The transition that drops a ticket (D43): into a cancel-like status when the
 * workflow has one that closes the ticket, else the first done one. Null when
 * neither is offered. A cancel-like transition into a status that is not
 * done-category ("Reject" back to In Progress) does not close it, so it is
 * never taken; one Jira returns without a category is.
 */
export function dropTransition(transitions: readonly Transition[]): Transition | null {
  const closes = transitions.filter(
    (t) => !t.to.statusCategory || t.to.statusCategory.key === "done",
  );
  return (
    closes.find((t) => isCancelStatus(t.to.name)) ??
    closes.find((t) => isCancelStatus(t.name)) ??
    doneTransitions(transitions)[0] ??
    null
  );
}

/** The comment that says why a ticket was dropped (D43). */
export function dropComment(reason: string, cancelled: boolean): string {
  const why = reason.trim();
  return cancelled ? `Dropped: ${why}` : `Closed without being done: ${why}`;
}

/**
 * Whether the user's newest comment on a ticket is already `body` (wiki, as
 * sent): a drop whose move failed after its comment posted is retried without
 * commenting again (D43, D49).
 */
export function alreadyCommented(
  comments: readonly { author?: { id: string } | undefined; body: string; created: string }[],
  me: string | null,
  body: string,
): boolean {
  if (!me) return false;
  const mine = comments
    .filter((c) => c.author?.id === me)
    .sort((a, b) => Date.parse(b.created) - Date.parse(a.created))[0];
  return !!mine && mine.body.replace(/\r\n/g, "\n").trim() === body.trim();
}

export const SNOOZE_PRESETS = ["tomorrow", "monday", "sprint"] as const;
export type SnoozePreset = (typeof SNOOZE_PRESETS)[number];

/**
 * The day (YYYY-MM-DD) a snooze ends: tomorrow is the next working day, Monday
 * the next Monday, "after the sprint" the first working day after the user's
 * active sprint ends. Null when there is no such day (no sprint, or it ended).
 */
export function snoozeDay(
  preset: SnoozePreset,
  today: string,
  sprintEnd: string | null,
): string | null {
  switch (preset) {
    case "tomorrow":
      return addBusinessDays(today, 1);
    case "monday": {
      const day = new Date(`${today}T00:00:00Z`).getUTCDay();
      const ahead = (8 - day) % 7 || 7;
      return new Date(Date.parse(`${today}T00:00:00Z`) + ahead * 86_400_000)
        .toISOString()
        .slice(0, 10);
    }
    case "sprint":
      return sprintEnd && sprintEnd >= today ? addBusinessDays(sprintEnd, 1) : null;
  }
}

/**
 * A snooze day: valid only after today and, when given, after `after` (a
 * wait's back day, `waitSnoozeAfter`), since an earlier one changes nothing.
 */
export const validSnoozeDay = (day: string, today: string, after: string | null = null) =>
  isRealDate(day) && daysBetween(today, day) > 0 && (!after || day > after);

/** `issue_meta.snoozed_until` for a day: local midnight as an ISO time. */
export const snoozeUntil = (day: string) => new Date(`${day}T00:00:00`).toISOString();

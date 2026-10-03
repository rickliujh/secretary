/**
 * Pure rules for Today's row actions (D49): which Jira transition finishes a
 * ticket, which one drops it (D43), and the snooze presets.
 */
import { addBusinessDays, daysBetween } from "@/lib/dates";
import type { Transition } from "@/services/jira/schemas";

/**
 * Statuses that end a ticket without doing it (D43). The same words as the
 * classify validation's check (`prompts/classify.ts`), which should import
 * this one.
 */
export const CANCEL_STATUS =
  /cancel|won'?t\s*(do|fix)|wontfix|abandon|reject|declin|obsolete|duplicate|invalid|not\s*needed|descoped/i;

export const isCancelStatus = (status: string) => CANCEL_STATUS.test(status);

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
 * workflow has one, else the first done one. Null when neither is offered.
 */
export function dropTransition(transitions: readonly Transition[]): Transition | null {
  return (
    transitions.find((t) => isCancelStatus(t.to.name)) ??
    transitions.find((t) => isCancelStatus(t.name)) ??
    doneTransitions(transitions)[0] ??
    null
  );
}

/** The comment that says why a ticket was dropped (D43). */
export function dropComment(reason: string, cancelled: boolean): string {
  const why = reason.trim();
  return cancelled ? `Dropped: ${why}` : `Closed without being done: ${why}`;
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

/** A day the user picked: valid only after today. */
export const validSnoozeDay = (day: string, today: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(day)) && daysBetween(today, day) > 0;

/** `issue_meta.snoozed_until` for a day: local midnight as an ISO time. */
export const snoozeUntil = (day: string) => new Date(`${day}T00:00:00`).toISOString();

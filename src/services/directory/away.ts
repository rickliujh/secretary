/**
 * A contact's away date (D47): their last day away, as a local YYYY-MM-DD date.
 * Pure helpers for showing it and for checking a date the model proposes.
 */
import { daysBetween, isRealDate } from "@/lib/dates";

export { isRealDate } from "@/lib/dates";

/** Furthest ahead an away date may be: catches a wrong year without refusing long leave. */
export const MAX_AWAY_DAYS = 180;

/**
 * Whether the contact is away on `today`. A past date is ignored, not cleared,
 * and so is a stored value that is not a real date (an import, an old row).
 */
export const isAway = (awayUntil: string | null | undefined, today: string) =>
  !!awayUntil && isRealDate(awayUntil) && awayUntil >= today;

/** "Away until 14 Oct" while away, else null. */
export function awayLabel(awayUntil: string | null | undefined, today: string): string | null {
  if (!awayUntil || !isAway(awayUntil, today)) return null;
  const day = new Date(`${awayUntil}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  return `Away until ${day}`;
}

/**
 * Why a proposed away date is not acceptable, or null when it is: a real date,
 * not before today and at most `MAX_AWAY_DAYS` ahead.
 */
export function awayDateProblem(value: string, today: string): string | null {
  if (!isRealDate(value)) return `${value} is not a real date; use YYYY-MM-DD`;
  if (value < today) return `${value} is in the past (today is ${today})`;
  if (daysBetween(today, value) > MAX_AWAY_DAYS)
    return `${value} is more than ${MAX_AWAY_DAYS} days away; check the year`;
  return null;
}

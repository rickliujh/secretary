/**
 * Calendar dates as YYYY-MM-DD strings. "Local" means the user's time zone;
 * whole-day arithmetic on YYYY-MM-DD values is done in UTC so it never
 * trips over daylight saving changes.
 */

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const DAY_MS = 86_400_000;
const toUtc = (date: string) => Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
const fromUtc = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Today (or `d`) as YYYY-MM-DD in local time. */
export const localDate = (d = new Date()) => d.toLocaleDateString("en-CA");

/** A YYYY-MM-DD value as is, or the local date of an ISO timestamp. */
export const localDateOf = (value: string) =>
  value.length === 10 ? value : localDate(new Date(value));

/**
 * Whole days from `a` to `b` (positive when `b` is later). Timestamps count by
 * the date they were written with.
 */
export const daysBetween = (a: string, b: string) => Math.round((toUtc(b) - toUtc(a)) / DAY_MS);

/** Adds working days (Monday to Friday). */
export function addBusinessDays(date: string, n: number): string {
  let ms = toUtc(date);
  let left = n;
  while (left > 0) {
    ms += DAY_MS;
    const day = new Date(ms).getUTCDay();
    if (day !== 0 && day !== 6) left--;
  }
  return fromUtc(ms);
}

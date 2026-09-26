/**
 * Calendar dates as YYYY-MM-DD strings. "Local" means the user's time zone;
 * whole-day arithmetic on YYYY-MM-DD values is done in UTC so it never
 * trips over daylight saving changes.
 */

/** Today (or `d`) as YYYY-MM-DD in local time. */
export const localDate = (d = new Date()) => d.toLocaleDateString("en-CA");

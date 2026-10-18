/**
 * Dates an event's words may mean (D61): the state update may only use a date
 * that is in the facts or in an event's text, so code works out every date the
 * text could name, relative to the day the event happened. Generous on purpose:
 * "Friday" counts as this week's and next week's Friday, since the check only
 * rejects dates nothing supports.
 */
// English only, like the app's UI: the locale module keeps the other languages out of the bundle.
import * as en from "chrono-node/en";
import { isRealDate } from "@/lib/dates";

const DAY_MS = 86_400_000;
const utc = (date: string) => Date.parse(`${date}T00:00:00Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const addDays = (date: string, n: number) => iso(utc(date) + n * DAY_MS);
const weekdayOf = (date: string) => new Date(utc(date)).getUTCDay();

const WEEKDAYS = [
  ["sunday", "sun"],
  ["monday", "mon"],
  ["tuesday", "tue", "tues"],
  ["wednesday", "wed"],
  ["thursday", "thu", "thur", "thurs"],
  ["friday", "fri"],
  ["saturday", "sat"],
] as const;

/** The next day on or after `from` that falls on `weekday` (0 = Sunday). */
const nextWeekday = (from: string, weekday: number) =>
  addDays(from, (weekday - weekdayOf(from) + 7) % 7);

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Every YYYY-MM-DD date `text` may name, read on `on` (a local YYYY-MM-DD date).
 * Sorted, without duplicates.
 */
export function datesInText(text: string, on: string): string[] {
  const out = new Set<string>();
  if (!text.trim() || !isRealDate(on)) return [];
  for (const m of text.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g))
    if (m[1] && isRealDate(m[1])) out.add(m[1]);

  // chrono reads "Friday now" as "now": drop the word, it never names a date.
  const words = text.replace(/\bnow\b/gi, " ");
  const [y, mo, d] = on.split("-").map(Number);
  const ref = new Date(y ?? 2000, (mo ?? 1) - 1, d ?? 1, 12, 0, 0);
  for (const parser of [en.GB, en.casual]) {
    for (const r of parser.parse(words, ref, { forwardDate: true })) {
      for (const c of [r.start, r.end]) {
        if (!c) continue;
        const date = `${c.get("year")}-${pad(c.get("month") ?? 1)}-${pad(c.get("day") ?? 1)}`;
        if (isRealDate(date)) out.add(date);
      }
    }
  }

  const lower = text.toLowerCase();
  WEEKDAYS.forEach((names, weekday) => {
    if (!names.some((n) => new RegExp(`\\b${n}\\b`).test(lower))) return;
    const first = nextWeekday(on, weekday);
    out.add(first);
    out.add(addDays(first, 7));
  });
  const friday = nextWeekday(on, 5);
  if (/\b(end of (the )?week|eow|this week)\b/.test(lower)) out.add(friday);
  if (/\bnext week\b/.test(lower)) {
    out.add(addDays(nextWeekday(on, 1), weekdayOf(on) === 1 ? 7 : 0));
    out.add(addDays(friday, 7));
  }
  if (/\b(end of (the )?month|eom)\b/.test(lower)) {
    const next = new Date(Date.UTC(y ?? 2000, mo ?? 1, 1));
    out.add(iso(next.getTime() - DAY_MS));
  }
  if (/\b(today|eod|end of (the )?day|tonight)\b/.test(lower)) out.add(on);
  if (/\btomorrow\b/.test(lower)) out.add(addDays(on, 1));
  return [...out].sort();
}

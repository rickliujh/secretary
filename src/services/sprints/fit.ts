/**
 * Whether the user's sprint has room (FR-16, D57), computed in code: working
 * days left, the user's open load, the other new tickets of a thread that join
 * it, the ticket itself, a rate (working days per story point) and a verdict.
 * Days off, holidays and Jira's remaining-estimate fields are not counted.
 */

const DAY_MS = 86_400_000;
const toUtc = (date: string) => Date.parse(`${date.slice(0, 10)}T00:00:00Z`);
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** Share of the days left the need may take and still "fit"; above it is "tight". */
export const FITS_SHARE = 0.85;

/** Monday-to-Friday days from `from` to `to`, both included; 0 when `to` is earlier. */
export function workingDaysBetween(from: string, to: string): number {
  const a = toUtc(from);
  const b = toUtc(to);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 0;
  let n = 0;
  for (let ms = a; ms <= b; ms += DAY_MS) {
    const day = new Date(ms).getUTCDay();
    if (day !== 0 && day !== 6) n++;
  }
  return n;
}

type SprintDates = {
  start: string | null;
  end: string | null;
  /** Jira's end timestamp, when sync kept it. */
  endAt?: string | null;
  state?: string;
};

const pad = (n: number) => String(n).padStart(2, "0");
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * The sprint's last working day for the count: its end date, or, when Jira's
 * end carries a time of day, the local date of that moment, which counts only
 * when it is at or after 12:00 local (a sprint that ends at 09:00 Monday leaves
 * Monday out). Null without an end.
 */
export function lastSprintDay(sprint: SprintDates): string | null {
  if (!sprint.end) return null;
  const at = sprint.endAt;
  if (!at || !/T\d{2}:\d{2}/.test(at)) return sprint.end.slice(0, 10);
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return sprint.end.slice(0, 10);
  if (d.getHours() >= 12) return localDay(d);
  return localDay(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1));
}

/**
 * Working days left in a sprint: from max(today, its start) to its last day
 * (`lastSprintDay`), both included (today counts in full); 0 once it has passed.
 */
export function workingDaysLeft(sprint: SprintDates, today: string): number {
  const last = lastSprintDay(sprint);
  if (!last) return 0;
  const from = sprint.start && sprint.start > today ? sprint.start : today;
  return workingDaysBetween(from, last);
}

/** "Fri 17 Oct" for a YYYY-MM-DD date. */
export function shortDay(date: string): string {
  const d = new Date(toUtc(date));
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/**
 * "ends Fri 17 Oct, 3 working days left"; past its end, "ended Tue 14 Oct", and
 * "not closed yet" while Jira still has it active.
 */
export function sprintWhen(sprint: SprintDates, today: string) {
  if (!sprint.end) return "no end date";
  const end = sprint.end.slice(0, 10);
  if (end < today)
    return `ended ${shortDay(end)}${sprint.state === "active" ? ", not closed yet" : ""}`;
  const left = workingDaysLeft(sprint, today);
  return `ends ${shortDay(end)}, ${left} working ${left === 1 ? "day" : "days"} left`;
}

/** One cached ticket as the load counts it (D35's rules). */
export type LoadIssue = {
  assignee: string | null;
  sprint: string | null;
  statusCategory: string;
  issueType: string;
  isSubtask?: boolean;
  storyPoints: number | null;
  stale?: boolean;
};

export type Load = {
  /** Open tickets counted. */
  count: number;
  /** Their points; unestimated ones add nothing. */
  points: number;
  /** How many of them have no points. */
  unestimated: number;
};

/**
 * The user's open tickets in a sprint: assignee is the user, not done, not
 * stale, not an Epic, not a sub-task. In-progress tickets count in full.
 */
export function userLoad(issues: readonly LoadIssue[], sprint: string, me: string | null): Load {
  const open = issues.filter(
    (i) =>
      !!me &&
      i.assignee === me &&
      i.sprint === sprint &&
      i.statusCategory !== "done" &&
      !i.stale &&
      !i.isSubtask &&
      !/epic/i.test(i.issueType),
  );
  return {
    count: open.length,
    points: open.reduce((n, i) => n + (i.storyPoints ?? 0), 0),
    unestimated: open.filter((i) => i.storyPoints === null).length,
  };
}

export type Rate = {
  daysPerPoint: number;
  /** settings: Settings > General > Sprint; velocity: the user's last `sprints` closed sprints. */
  source: "settings" | "velocity";
  sprints?: number;
};

/**
 * Days per point from the user's last closed sprints on a board (D30's
 * velocity): their working days over the points the user finished in them.
 * Null without sprints or finished points.
 */
export function velocityRate(
  rows: readonly { start: string | null; end: string | null; points: number }[],
): Rate | null {
  const dated = rows.filter((r) => r.start && r.end);
  const points = dated.reduce((n, r) => n + r.points, 0);
  if (!dated.length || points <= 0) return null;
  const days = dated.reduce((n, r) => n + workingDaysBetween(r.start ?? "", r.end ?? ""), 0);
  if (days <= 0) return null;
  return { daysPerPoint: days / points, source: "velocity", sprints: dated.length };
}

/** The setting when set, else the derived rate, else none. */
export function chooseRate(setting: number | null | undefined, derived: Rate | null): Rate | null {
  if (typeof setting === "number" && setting > 0)
    return { daysPerPoint: setting, source: "settings" };
  return derived;
}

/** A new ticket: this one, or another pending create of the thread that joins the sprint. */
export type FitTicket = {
  /** Summary, for the details. */
  label: string;
  points: number | null;
  /** Its assignee; empty or the user counts toward the user. */
  assignee: string | null;
  /** The assignee's display name, for the details; "someone else" without one. */
  assigneeName?: string | null;
};

export type Verdict = "fits" | "tight" | "over" | "unknown";

export type Fit = {
  verdict: Verdict;
  /** This ticket has no points, but without it the sprint is already tight or over. */
  already: boolean;
  /** Why the verdict is unknown: no rate, or this ticket has no points. */
  missing: "rate" | "points" | null;
  daysLeft: number;
  ended: boolean;
  rate: Rate | null;
  load: Load;
  /** Other new tickets that join; `counted` false for one assigned to someone else. */
  others: (FitTicket & { counted: boolean })[];
  ticket: (FitTicket & { counted: boolean }) | null;
  /** Points counted: load, the counted others and this ticket. */
  points: number;
  /** Those points in days, rounded to the half day; null without a rate. */
  days: number | null;
  /** Unestimated tickets counted: the load's, the others' and this one. */
  unestimated: number;
  /** One line: verdict, days and "plus N unestimated". */
  headline: string;
  /** The details, one line each. */
  details: string[];
};

/** Rounds to the half day. */
export const halfDays = (d: number) => Math.round(d * 2) / 2;
/** Rounds up to the half day, so a need shown never looks smaller than it is. */
export const halfDaysUp = (d: number) => (d <= 0 ? 0 : Math.ceil(d * 2 - 1e-9) / 2);
const num = (n: number) => String(Math.round(n * 100) / 100);
const ptsText = (n: number) => `${num(n)} ${n === 1 ? "point" : "points"}`;
const daysText = (n: number) => `${num(n)} ${n === 1 ? "day" : "days"}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function judge(need: number, daysLeft: number): Exclude<Verdict, "unknown"> {
  // Nothing to do fits even a sprint with no days left.
  if (need <= 0) return "fits";
  if (daysLeft <= 0) return "over";
  if (need <= FITS_SHARE * daysLeft) return "fits";
  if (need <= daysLeft) return "tight";
  return "over";
}

const VERDICT_WORD: Record<Exclude<Verdict, "unknown">, string> = {
  fits: "Fits",
  tight: "Tight",
  over: "Over",
};

/**
 * A need in days as the headline shows it: up to the half day, but a "fits"
 * never shows as all the days left, so the numbers never contradict the verdict
 * (tight and over already read right rounded up).
 */
export function shownDays(need: number, daysLeft: number, verdict: Verdict): number {
  const up = halfDaysUp(need);
  if (verdict === "fits" && need > 0 && daysLeft > 0 && up >= daysLeft)
    return Math.max(0.5, daysLeft - 0.5);
  return up;
}

/**
 * The verdict for the user's load plus `others` plus `ticket` (D57). Without a
 * rate it is unknown; a ticket without points is unknown unless the sprint is
 * already tight or over without it. With 0 days left any need is over.
 */
export function sprintFit(input: {
  daysLeft: number;
  ended?: boolean;
  load: Load;
  others?: readonly FitTicket[];
  ticket?: FitTicket | null;
  rate: Rate | null;
  me: string | null;
}): Fit {
  const { daysLeft, load, rate, me } = input;
  const ended = input.ended ?? false;
  const counts = (t: FitTicket) => t.assignee === null || t.assignee === "" || t.assignee === me;
  const others = (input.others ?? []).map((t) => ({ ...t, counted: counts(t) }));
  const ticket = input.ticket ? { ...input.ticket, counted: counts(input.ticket) } : null;
  const counted = others.filter((t) => t.counted);
  const before = load.points + counted.reduce((n, t) => n + (t.points ?? 0), 0);
  const mine = ticket?.counted ? (ticket.points ?? 0) : 0;
  const points = before + mine;
  const unestimated =
    load.unestimated +
    counted.filter((t) => t.points === null).length +
    (ticket?.counted && ticket.points === null ? 1 : 0);
  const toDays = (p: number) => (rate ? halfDaysUp(p * rate.daysPerPoint) : null);
  const need = rate ? points * rate.daysPerPoint : null;
  const needBefore = rate ? before * rate.daysPerPoint : null;
  const unsized = !!ticket?.counted && ticket.points === null;

  let verdict: Verdict = "unknown";
  let already = false;
  let missing: Fit["missing"] = null;
  if (need === null || needBefore === null) missing = "rate";
  else if (unsized) {
    const without = judge(needBefore, daysLeft);
    if (without === "fits") missing = "points";
    else {
      verdict = without;
      already = true;
    }
  } else verdict = judge(need, daysLeft);

  // The days shown agree with the verdict they go with (`shownDays`).
  const shown = (n: number | null, v: Verdict) => (n === null ? null : shownDays(n, daysLeft, v));
  const of = (d: number | null) => `about ${num(d ?? 0)} of ${plural(daysLeft, "working day")}`;
  let headline: string;
  if (missing === "rate")
    headline = `${ptsText(points)}, ${plural(daysLeft, "working day")} left; set what a point means to size it`;
  else if (ended && verdict !== "unknown")
    headline =
      need === 0 && !already
        ? "Fits: nothing open; the sprint has ended but is not closed yet"
        : `${VERDICT_WORD[verdict]}: the sprint has ended but is not closed yet`;
  else if (already)
    headline = `${VERDICT_WORD[verdict as "tight" | "over"]} already without this ticket: ${of(shown(needBefore, verdict))}`;
  else if (missing === "points")
    headline = `Add points to size it: ${of(shown(needBefore, "fits"))} so far`;
  else
    headline = `${VERDICT_WORD[verdict as "fits" | "tight" | "over"]}: ${of(shown(need, verdict))}`;
  if (unestimated > 0) headline += `, plus ${unestimated} unestimated`;

  const ticketLine = (t: FitTicket & { counted: boolean }) =>
    !t.counted
      ? `assigned to ${t.assigneeName || "someone else"}, not counted`
      : t.points === null
        ? "no points"
        : rate
          ? `${ptsText(t.points)}, about ${daysText(toDays(t.points) ?? 0)}`
          : ptsText(t.points);
  const details = [
    `Your open tickets there: ${load.count}, ${ptsText(load.points)}${
      rate ? `, about ${daysText(toDays(load.points) ?? 0)}` : ""
    }${load.unestimated ? `, ${load.unestimated} unestimated` : ""}`,
    ...(others.length
      ? [
          `Other new tickets here that join it: ${others
            .map((t) => `${t.label} (${ticketLine(t)})`)
            .join("; ")}`,
        ]
      : []),
    ...(ticket ? [`This ticket: ${ticketLine(ticket)}`] : []),
    rate
      ? `1 point is about ${daysText(rate.daysPerPoint)}, ${
          rate.source === "settings"
            ? "from Settings"
            : `from your last ${plural(rate.sprints ?? 0, "sprint")}`
        }`
      : "No rate yet: set what a point means in Settings",
  ];
  return {
    verdict,
    already,
    missing,
    daysLeft,
    ended,
    rate,
    load,
    others,
    ticket,
    points,
    days: shown(need, verdict),
    unestimated,
    headline,
    details,
  };
}

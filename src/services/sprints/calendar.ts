/**
 * Sprint calendar (design.md D23): quarters, positions within a quarter and
 * projected future sprints, computed from dates alone so nothing depends on how
 * teams name their sprints.
 */
import { MONTH_NAMES } from "@/lib/dates";

export type SprintInfo = {
  id: number;
  name: string;
  /** closed, active or future, as Jira reports it. */
  state: string;
  boardId: number | null;
  /** YYYY-MM-DD in the sprint's own time zone, when Jira has dates. */
  start: string | null;
  end: string | null;
};

export type CalendarSprint = {
  name: string;
  boardId: number | null;
  state: "closed" | "active" | "future" | "projected";
  start: string;
  end: string;
  /** e.g. "Q4 2026 (Oct–Dec)" or "FY2027 Q2 (Oct–Dec 2026)". */
  quarter: string;
  /** Position among the board's sprints starting in that quarter; null when its history is incomplete. */
  ordinal: number | null;
};

const DAY = 86_400_000;
const MONTHS = MONTH_NAMES.map((m) => m.slice(0, 3));
/** A board whose last sprint ended longer ago than this is not projected forward. */
const IDLE_DAYS = 60;
const MAX_PROJECTED = 20;

const toDay = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / DAY;
const fromDay = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);
const median = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b);
  return s.length ? (s[Math.floor((s.length - 1) / 2)] ?? 0) : 0;
};

/** The date part of a Jira timestamp, in the time zone it was written in. */
export const datePart = (value: string | null | undefined) =>
  value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;

/**
 * The quarter a date falls in. With a fiscal year starting in a month other than
 * January, the fiscal year is named after the calendar year it ends in.
 */
export function quarterOf(date: string, fyStartMonth = 1) {
  const [y, m] = date.split("-").map(Number) as [number, number];
  const q = Math.floor(((m - fyStartMonth + 12) % 12) / 3) + 1;
  const first = ((fyStartMonth - 1 + (q - 1) * 3) % 12) + 1;
  const last = ((first + 1) % 12) + 1;
  const months = `${MONTHS[first - 1]}–${MONTHS[last - 1]}`;
  if (fyStartMonth === 1) return { key: `${y}-Q${q}`, label: `Q${q} ${y} (${months})` };
  const fy = m >= fyStartMonth ? y + 1 : y;
  const startYear = first > m ? y - 1 : y;
  return { key: `FY${fy}-Q${q}`, label: `FY${fy} Q${q} (${months} ${startYear})` };
}

const stateOf = (s: string): CalendarSprint["state"] => {
  const v = s.toLowerCase();
  return v === "active" || v === "future" ? v : "closed";
};

/**
 * Every dated sprint of each board around `today`, plus projections from the
 * board's usual length and cadence, labelled with quarter and position.
 */
export function buildCalendar(
  sprints: readonly SprintInfo[],
  opts: {
    today: string;
    fyStartMonth?: number;
    /** Boards whose whole sprint history was fetched, so positions can be counted. */
    completeBoards?: ReadonlySet<number>;
    horizonDays?: number;
    pastDays?: number;
  },
): CalendarSprint[] {
  const fy = opts.fyStartMonth ?? 1;
  const today = toDay(opts.today);
  const horizon = today + (opts.horizonDays ?? 200);
  const past = today - (opts.pastDays ?? 21);
  const boards = new Map<number | null, SprintInfo[]>();
  for (const s of sprints)
    if (s.start && s.end) boards.set(s.boardId, [...(boards.get(s.boardId) ?? []), s]);

  const out: CalendarSprint[] = [];
  for (const [boardId, list] of boards) {
    const dated = [...list].sort(
      (a, b) => (a.start ?? "").localeCompare(b.start ?? "") || a.id - b.id,
    );
    const rows = dated.map((s) => ({
      name: s.name,
      state: stateOf(s.state),
      start: s.start ?? "",
      end: s.end ?? "",
    }));
    const starts = dated.map((s) => toDay(s.start ?? ""));
    const steps = starts
      .slice(1)
      .map((d, i) => d - (starts[i] ?? d))
      .filter((x) => x > 0)
      .slice(-4);
    const length = median(
      dated
        .slice(-4)
        .map((s) => toDay(s.end ?? "") - toDay(s.start ?? ""))
        .filter((x) => x > 0),
    );
    const step = median(steps) || length;
    const last = dated.at(-1);
    if (last?.end && step > 0 && length > 0 && toDay(last.end) >= today - IDLE_DAYS) {
      let start = toDay(last.start ?? last.end) + step;
      for (let k = 1; k <= MAX_PROJECTED && start <= horizon; k++, start += step) {
        rows.push({
          name: `projected ${k} after ${last.name}`,
          state: "projected",
          start: fromDay(start),
          end: fromDay(start + length),
        });
      }
    }
    const complete = boardId !== null && (opts.completeBoards?.has(boardId) ?? false);
    const seen = new Map<string, number>();
    for (const r of rows) {
      const q = quarterOf(r.start, fy);
      const ordinal = (seen.get(q.key) ?? 0) + 1;
      seen.set(q.key, ordinal);
      if (toDay(r.end) < past || toDay(r.start) > horizon) continue;
      out.push({ ...r, boardId, quarter: q.label, ordinal: complete ? ordinal : null });
    }
  }
  return out;
}

/** One sprint as the classify prompt shows it. */
export type PromptSprint = {
  board: string;
  name: string;
  state: CalendarSprint["state"];
  start: string;
  end: string;
  quarter: string;
  position: number | null;
};

const MAX_PROMPT_BOARDS = 3;

/**
 * The calendar for one item: boards whose issues belong to the item's projects,
 * or the busiest boards when none match, so the prompt stays small.
 */
export function promptSprints(
  data: {
    sprints: SprintInfo[];
    completeBoards: number[];
    boardProjects: Record<string, string[]>;
  },
  opts: { today: string; fyStartMonth: number; projects: readonly string[] },
): PromptSprint[] {
  const projectsOf = (board: number | null) =>
    board === null ? [] : (data.boardProjects[String(board)] ?? []);
  const counts = new Map<number | null, number>();
  for (const s of data.sprints) counts.set(s.boardId, (counts.get(s.boardId) ?? 0) + 1);
  const related = [...counts.keys()].filter((b) =>
    projectsOf(b).some((p) => opts.projects.includes(p)),
  );
  const boards = new Set(
    (related.length ? related : [...counts].sort((a, b) => b[1] - a[1]).map(([b]) => b)).slice(
      0,
      MAX_PROMPT_BOARDS,
    ),
  );
  return buildCalendar(
    data.sprints.filter((s) => boards.has(s.boardId)),
    {
      today: opts.today,
      fyStartMonth: opts.fyStartMonth,
      completeBoards: new Set(data.completeBoards),
    },
  ).map((s) => ({
    board: projectsOf(s.boardId).length
      ? `${projectsOf(s.boardId).join("/")} board`
      : s.boardId === null
        ? "unknown board"
        : `board ${s.boardId}`,
    name: s.name,
    state: s.state,
    start: s.start,
    end: s.end,
    quarter: s.quarter,
    position: s.ordinal,
  }));
}

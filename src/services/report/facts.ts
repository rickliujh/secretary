/**
 * Recap facts (D37): pure grouping of the cache, comments and Jira change
 * history into what was done, what is in progress, what is new or changed,
 * what is blocked and what is next. The model only writes these up.
 */
import type { ReportGroup, ReportPeriod, ReportTicket } from ".";

/** One entry of an issue's Jira change history (see `JiraClient.issueHistory`). */
export type HistoryEntry = {
  at: string;
  author: string | null;
  authorDisplay: string | null;
  items: { field: string; from: string | null; to: string | null; toId: string | null }[];
};

export type RecapIssue = {
  key: string;
  summary: string;
  issueType: string;
  isSubtask: boolean;
  status: string;
  statusCategory: "new" | "indeterminate" | "done";
  assignee: string | null;
  reporter: string | null;
  reporterDisplay: string | null;
  epicKey: string | null;
  sprint: string | null;
  storyPoints: number | null;
  dueDate: string | null;
  created: string;
  updated: string;
  resolved: string | null;
  /** Unresolved blockers from issue links. */
  blockedBy: string[];
};

export type RecapComment = {
  issueKey: string;
  author: string | null;
  authorDisplay: string | null;
  created: string;
  body: string;
};

export type RecapInputs = {
  me: string;
  since: string;
  until: string;
  /** Tracked epics whose tickets count too; empty for "my work only". */
  tracked: ReadonlySet<string>;
  activeSprints: ReadonlySet<string>;
  /** Dashboard focus order, best first, to order "next". */
  focus: readonly string[];
  issues: readonly RecapIssue[];
  /** Comments created in the period. */
  comments: readonly RecapComment[];
  /** History in the period, by issue key. */
  history: ReadonlyMap<string, readonly HistoryEntry[]>;
};

export type RecapTicket = ReportTicket & {
  /** The latest comment by someone else in the period, clipped; untrusted text. */
  quote: string | null;
};

export type RecapFacts = {
  tickets: RecapTicket[];
  stats: { done: number; pointsDone: number; inProgress: number; new: number; comments: number };
};

const IN_PROGRESS_LIMIT = 12;
const NEXT_LIMIT = 6;
const CHANGED_LIMIT = 15;
const QUOTE_CHARS = 200;
/** Fields worth reporting from history; Jira names them in lower or title case. */
const NOTABLE = new Set([
  "status",
  "assignee",
  "priority",
  "duedate",
  "sprint",
  "story points",
  "story point estimate",
  "resolution",
  "fix version",
  "summary",
]);

const DAY = 86_400_000;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "25 Sep" in local time; notes are facts for the prompt, not UI text. */
const shortDay = (iso: string) => {
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
};

const startOfDay = (d: Date) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

/**
 * The period a report covers, until now. A working day look-back skips the
 * weekend, so on Monday it starts on Friday.
 */
export function reportWindow(
  period: ReportPeriod,
  now: Date,
): { since: string; until: string; label: string } {
  const today = startOfDay(now);
  if (period.kind === "workday") {
    const start = new Date(today);
    do start.setDate(start.getDate() - 1);
    while (start.getDay() === 0 || start.getDay() === 6);
    const yesterday = today.getTime() - start.getTime() <= DAY + 3_600_000;
    return {
      since: start.toISOString(),
      until: now.toISOString(),
      label: yesterday
        ? "Since yesterday"
        : `Since ${start.toLocaleDateString("en-GB", { weekday: "long" })}`,
    };
  }
  const days = Math.min(Math.max(Math.round(period.days), 1), 30);
  const start = new Date(today);
  start.setDate(start.getDate() - days);
  return {
    since: start.toISOString(),
    until: now.toISOString(),
    label: days === 1 ? "Since yesterday" : `Last ${days} days`,
  };
}

const who = (id: string | null, display: string | null, me: string) =>
  id !== null && id === me ? "you" : (display ?? id ?? "someone");

function historyNotes(entries: readonly HistoryEntry[], me: string): string[] {
  const notes: string[] = [];
  for (const e of entries) {
    const by = who(e.author, e.authorDisplay, me);
    for (const item of e.items) {
      const field = item.field.toLowerCase();
      if (!NOTABLE.has(field)) continue;
      const when = shortDay(e.at);
      if (field === "status")
        notes.push(`${item.from ?? "?"} -> ${item.to ?? "?"} (${by}, ${when})`);
      else if (field === "assignee")
        notes.push(
          item.toId === me
            ? `Assigned to you (by ${by}, ${when})`
            : `Assigned to ${item.to ?? "nobody"} (by ${by}, ${when})`,
        );
      else if (field === "summary") notes.push(`Renamed (by ${by}, ${when})`);
      else notes.push(`${item.field}: ${item.from ?? "none"} -> ${item.to ?? "none"} (${when})`);
    }
  }
  return notes;
}

export function buildRecapFacts(input: RecapInputs): RecapFacts {
  const { me, since, tracked } = input;
  const inWindow = (iso: string | null) => !!iso && iso >= since;
  const mine = (i: RecapIssue) => i.assignee === me;
  const inScope = (i: RecapIssue) =>
    mine(i) || i.reporter === me || (!!i.epicKey && tracked.has(i.epicKey)) || tracked.has(i.key);
  const isEpic = (i: RecapIssue) => /epic/i.test(i.issueType);

  const commentsBy = new Map<string, RecapComment[]>();
  for (const c of input.comments)
    commentsBy.set(c.issueKey, [...(commentsBy.get(c.issueKey) ?? []), c]);
  const focusRank = new Map(input.focus.map((k, n) => [k, n]));

  const tickets: RecapTicket[] = [];
  const add = (i: RecapIssue, group: ReportGroup, extra: string[] = []) => {
    const history = input.history.get(i.key) ?? [];
    const cs = commentsBy.get(i.key) ?? [];
    const others = cs.filter((c) => c.author !== me);
    const own = cs.length - others.length;
    const notes = [...extra, ...historyNotes(history, me)];
    if (others.length) {
      const names = [...new Set(others.map((c) => c.authorDisplay ?? c.author ?? "someone"))];
      notes.push(
        `${others.length} comment${others.length === 1 ? "" : "s"} from ${names.slice(0, 3).join(", ")}`,
      );
    }
    if (own) notes.push(`You commented${own > 1 ? ` ${own} times` : ""}`);
    if (i.blockedBy.length) notes.push(`Blocked by ${i.blockedBy.slice(0, 3).join(", ")}`);
    if (i.dueDate && group !== "done") notes.push(`Due ${shortDay(`${i.dueDate}T12:00:00`)}`);
    const latest = others.at(-1);
    tickets.push({
      key: i.key,
      summary: i.summary,
      status: i.status,
      points: i.storyPoints,
      group,
      notes,
      quote: latest ? latest.body.replace(/\s+/g, " ").trim().slice(0, QUOTE_CHARS) : null,
    });
  };

  const scoped = input.issues.filter((i) => inScope(i) && !isEpic(i));
  const used = new Set<string>();
  const take = (
    list: RecapIssue[],
    group: ReportGroup,
    extra: (i: RecapIssue) => string[] = () => [],
  ) => {
    for (const i of list) {
      if (used.has(i.key)) continue;
      used.add(i.key);
      add(i, group, extra(i));
    }
  };
  const byRecent = (a: RecapIssue, b: RecapIssue) => b.updated.localeCompare(a.updated);
  const activity = (i: RecapIssue) =>
    (input.history.get(i.key)?.length ?? 0) > 0 ||
    (commentsBy.get(i.key)?.length ?? 0) > 0 ||
    inWindow(i.updated);

  // Done: resolved in the period.
  const done = scoped
    .filter((i) => i.statusCategory === "done" && inWindow(i.resolved))
    .filter((i) => mine(i) || tracked.size > 0)
    .sort(byRecent);
  take(done, "done", (i) => [`Resolved ${shortDay(i.resolved as string)}`]);

  // New: created in the period, or assigned to me in it.
  const assignedToMe = (i: RecapIssue) =>
    (input.history.get(i.key) ?? []).some((e) =>
      e.items.some((x) => x.field.toLowerCase() === "assignee" && x.toId === me),
    );
  const fresh = scoped
    .filter((i) => i.statusCategory !== "done" && (inWindow(i.created) || assignedToMe(i)))
    .sort(byRecent);
  take(fresh, "new", (i) =>
    inWindow(i.created)
      ? [`Created ${shortDay(i.created)} by ${who(i.reporter, i.reporterDisplay, me)}`]
      : [],
  );

  // Blocked: my open work waiting on something.
  const blocked = scoped.filter(
    (i) =>
      mine(i) &&
      i.statusCategory !== "done" &&
      (i.blockedBy.length > 0 || /block|on hold/i.test(i.status)),
  );
  take(blocked, "blocked");

  // In progress: my started work, busiest first.
  const progress = scoped
    .filter((i) => mine(i) && i.statusCategory === "indeterminate")
    .sort((a, b) => Number(activity(b)) - Number(activity(a)) || byRecent(a, b))
    .slice(0, IN_PROGRESS_LIMIT);
  take(progress, "in_progress");

  // Changed: anything else in scope with activity in the period.
  const changed = scoped
    .filter((i) => !used.has(i.key) && i.statusCategory !== "done" && activity(i))
    .filter(
      (i) =>
        (input.history.get(i.key)?.length ?? 0) > 0 || (commentsBy.get(i.key)?.length ?? 0) > 0,
    )
    .sort(byRecent)
    .slice(0, CHANGED_LIMIT);
  take(changed, "changed");

  // Next: my to-do work, the active sprint's first, in focus order.
  const sprintFirst = (i: RecapIssue) => (i.sprint && input.activeSprints.has(i.sprint) ? 0 : 1);
  const next = scoped
    .filter((i) => mine(i) && i.statusCategory === "new" && !i.isSubtask)
    .filter((i) => input.activeSprints.size === 0 || sprintFirst(i) === 0 || focusRank.has(i.key))
    .sort(
      (a, b) =>
        sprintFirst(a) - sprintFirst(b) ||
        (focusRank.get(a.key) ?? 999) - (focusRank.get(b.key) ?? 999) ||
        a.key.localeCompare(b.key),
    )
    .slice(0, NEXT_LIMIT);
  take(next, "next");

  const scopedKeys = new Set(scoped.map((i) => i.key));
  const doneTickets = tickets.filter((t) => t.group === "done");
  return {
    tickets,
    stats: {
      done: doneTickets.length,
      pointsDone: doneTickets.reduce((n, t) => n + (t.points ?? 0), 0),
      inProgress: tickets.filter((t) => t.group === "in_progress").length,
      new: tickets.filter((t) => t.group === "new").length,
      comments: input.comments.filter((c) => scopedKeys.has(c.issueKey)).length,
    },
  };
}

/**
 * Recap facts (D37, D39): pure grouping of the cache, comments, Jira change
 * history and Waiting-on items into tickets with timelines, sprint health, epic
 * progress, risks and asks. The model only writes the talk track and a line or
 * two per ticket; every style is rendered from these facts.
 */
import { daysBetween } from "@/lib/dates";
import { timing } from "@/services/dependencies/logic";
import type {
  ReportDependency,
  ReportEpic,
  ReportEvent,
  ReportGroup,
  ReportPeriod,
  ReportTicket,
  SprintHealth,
} from ".";

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
  assigneeDisplay: string | null;
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

export type RecapDependency = {
  issueKey: string;
  label: string;
  owner: string;
  externalRef: string | null;
  status: "open" | "waiting" | "blocked" | "resolved";
  requestedAt: string | null;
  expectedAt: string | null;
  nextFollowupAt: string | null;
  /** Oldest first. */
  followups: { at: string; channel: string | null; summary: string | null }[];
};

/** Who and what a report covers (D37, D40). */
export type ReportScopeRule = {
  me: string;
  tracked: ReadonlySet<string>;
  activeSprints: ReadonlySet<string>;
  /** Only tickets in an active sprint; ignored when no sprint is active. */
  sprintOnly: boolean;
};

/**
 * A ticket is in the report when it is the user's (assigned or reported) or under
 * a tracked epic, and, with `sprintOnly` and an active sprint, in that sprint.
 */
export function inReportScope(i: RecapIssue, rule: ReportScopeRule): boolean {
  const who =
    i.assignee === rule.me ||
    i.reporter === rule.me ||
    (!!i.epicKey && rule.tracked.has(i.epicKey)) ||
    rule.tracked.has(i.key);
  if (!who) return false;
  if (!rule.sprintOnly || rule.activeSprints.size === 0) return true;
  return !!i.sprint && rule.activeSprints.has(i.sprint);
}

export type RecapInputs = {
  me: string;
  /** Only tickets in an active sprint (D40). */
  sprintOnly: boolean;
  since: string;
  until: string;
  /** Local date, YYYY-MM-DD. */
  today: string;
  /** Tracked epics whose tickets count too; empty for "my work only". */
  tracked: ReadonlySet<string>;
  activeSprints: ReadonlySet<string>;
  /** The active sprint holding the user's work, for sprint health. */
  sprint: { name: string; start: string | null; end: string | null } | null;
  /** Dashboard focus order, best first, to order "next". */
  focus: readonly string[];
  /** Every cached issue (epics too, for names and progress). */
  issues: readonly RecapIssue[];
  /** Comments created in the period. */
  comments: readonly RecapComment[];
  /** History in the period, by issue key. */
  history: ReadonlyMap<string, readonly HistoryEntry[]>;
  dependencies: readonly RecapDependency[];
  /** People waiting on the user (dashboard "Waiting on me"). */
  asks: readonly { key: string; who: string; what: string; at: string }[];
};

/** A ticket's facts before the model adds `happened` and `next`. */
export type RecapTicket = Omit<ReportTicket, "happened" | "next"> & {
  /** Comments in the period, clipped; other people's text, untrusted. */
  comments: { by: string; at: string; text: string }[];
};

export type RecapFacts = {
  tickets: RecapTicket[];
  epics: ReportEpic[];
  sprint: SprintHealth | null;
  risks: string[];
  asks: { key: string; who: string; what: string; at: string }[];
  stats: { done: number; pointsDone: number; inProgress: number; new: number; comments: number };
};

const IN_PROGRESS_LIMIT = 12;
const NEXT_LIMIT = 6;
const CHANGED_LIMIT = 15;
const COMMENT_CHARS = 300;
const COMMENTS_PER_TICKET = 5;
const EVENT_TEXT_CHARS = 100;
const DUE_RISK_DAYS = 3;
/** Fields worth reporting from history; Jira names them in lower or title case. */
const NOTABLE = new Set([
  "status",
  "assignee",
  "priority",
  "duedate",
  "sprint",
  "story points",
  "story point estimate",
  "fix version",
  "summary",
]);

const DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "25 Sep" in local time; notes are facts for the prompt and the styles. */
const shortDay = (iso: string) => {
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
};
const weekday = (date: string) => WEEKDAYS[new Date(`${date}T12:00:00`).getDay()];

const clip = (s: string, n: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
};

/** The question someone asked in a comment (its last "?" sentence), or its first words. */
export function askText(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  const sentences = flat.match(/[^.!?]+[.!?]*/g)?.map((x) => x.trim()) ?? [];
  let at = sentences.length - 1;
  while (at >= 0 && !((sentences[at] ?? "").endsWith("?") && (sentences[at] ?? "").length > 3))
    at--;
  if (at < 0) return clip(flat, 140);
  // "Can you add it?" needs the sentence before it to make sense.
  const q = sentences[at] ?? "";
  return clip(q.length < 40 && at > 0 ? `${sentences[at - 1]} ${q}` : q, 140);
}

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

/** Working days (Monday to Friday) from `from` to `to` inclusive, YYYY-MM-DD. */
export function workingDays(from: string, to: string): number {
  let n = 0;
  const d = new Date(`${from}T12:00:00`);
  const end = new Date(`${to}T12:00:00`);
  while (d <= end) {
    if (d.getDay() !== 0 && d.getDay() !== 6) n++;
    d.setDate(d.getDate() + 1);
  }
  return n;
}

const who = (id: string | null, display: string | null, me: string) =>
  id !== null && id === me ? "you" : (display ?? id ?? "someone");

function historyEvents(entries: readonly HistoryEntry[], me: string): ReportEvent[] {
  const out: ReportEvent[] = [];
  for (const e of entries) {
    const by = who(e.author, e.authorDisplay, me);
    for (const item of e.items) {
      const field = item.field.toLowerCase();
      if (!NOTABLE.has(field)) continue;
      if (field === "status")
        out.push({
          at: e.at,
          kind: "status",
          by,
          text: `${item.from ?? "?"} -> ${item.to ?? "?"}`,
        });
      else if (field === "assignee")
        out.push({
          at: e.at,
          kind: "assigned",
          by,
          text: item.toId === me ? "Assigned to you" : `Assigned to ${item.to ?? "nobody"}`,
        });
      else if (field === "summary") out.push({ at: e.at, kind: "field", by, text: "Renamed" });
      else
        out.push({
          at: e.at,
          kind: "field",
          by,
          text: `${item.field}: ${item.from ?? "none"} -> ${item.to ?? "none"}`,
        });
    }
  }
  return out;
}

export function buildRecapFacts(input: RecapInputs): RecapFacts {
  const { me, since, tracked, today } = input;
  const inWindow = (iso: string | null) => !!iso && iso >= since;
  const mine = (i: RecapIssue) => i.assignee === me;
  const inScope = (i: RecapIssue) =>
    inReportScope(i, {
      me,
      tracked,
      activeSprints: input.activeSprints,
      sprintOnly: input.sprintOnly,
    });
  const epicKeys = new Set(input.issues.map((i) => i.epicKey).filter((k): k is string => !!k));
  const isEpic = (i: RecapIssue) => /epic/i.test(i.issueType) || epicKeys.has(i.key);
  const byKey = new Map(input.issues.map((i) => [i.key, i]));

  const commentsBy = new Map<string, RecapComment[]>();
  for (const c of input.comments)
    commentsBy.set(c.issueKey, [...(commentsBy.get(c.issueKey) ?? []), c]);
  const depsBy = new Map<string, RecapDependency[]>();
  for (const d of input.dependencies)
    if (d.status !== "resolved") depsBy.set(d.issueKey, [...(depsBy.get(d.issueKey) ?? []), d]);
  // Asks: questions and mentions from others in the period on the user's tickets,
  // then older unanswered ones the dashboard knows about.
  const mentions = [`[~${me}]`, `[~accountid:${me}]`];
  const asks = new Map<string, { key: string; who: string; what: string; at: string }>();
  for (const c of input.comments) {
    const issue = byKey.get(c.issueKey);
    if (!issue || c.author === me || !(issue.assignee === me || issue.reporter === me)) continue;
    if (!inScope(issue)) continue;
    const mentioned = mentions.some((m) => c.body.toLowerCase().includes(m.toLowerCase()));
    if (!c.body.includes("?") && !mentioned) continue;
    asks.set(c.issueKey, {
      key: c.issueKey,
      who: c.authorDisplay ?? c.author ?? "Someone",
      what: askText(c.body),
      at: c.created,
    });
  }
  for (const a of input.asks) {
    const issue = byKey.get(a.key);
    if (!asks.has(a.key) && (!issue || inScope(issue))) asks.set(a.key, a);
  }
  const askBy = asks;
  const focusRank = new Map(input.focus.map((k, n) => [k, n]));

  const dependencyOf = (d: RecapDependency): ReportDependency => {
    const t = timing(d, today);
    return {
      label: d.label,
      owner: d.owner,
      externalRef: d.externalRef,
      status: d.status === "resolved" ? "open" : d.status,
      since: d.requestedAt,
      expectedAt: d.expectedAt,
      overdueDays: t.overdueDays,
      lastFollowup: d.followups.at(-1) ?? null,
      nextFollowupAt: d.nextFollowupAt,
      followupDue: t.followupDue,
    };
  };

  const eventsOf = (i: RecapIssue): ReportEvent[] => {
    const events = historyEvents(input.history.get(i.key) ?? [], me);
    const hasHistory = input.history.has(i.key);
    if (inWindow(i.created))
      events.push({
        at: i.created,
        kind: "created",
        by: who(i.reporter, i.reporterDisplay, me),
        text: mine(i) ? "Created and assigned to you" : "Created",
      });
    // Without history, the resolution date still says when it was finished.
    if (!hasHistory && i.statusCategory === "done" && inWindow(i.resolved))
      events.push({
        at: i.resolved as string,
        kind: "resolved",
        by: "someone",
        text: `-> ${i.status}`,
      });
    for (const c of commentsBy.get(i.key) ?? [])
      events.push({
        at: c.created,
        kind: "comment",
        by: who(c.author, c.authorDisplay, me),
        text: clip(c.body, EVENT_TEXT_CHARS),
      });
    for (const d of depsBy.get(i.key) ?? [])
      for (const f of d.followups)
        if (inWindow(f.at))
          events.push({
            at: f.at,
            kind: "followup",
            by: "you",
            text: `Chased ${d.owner} about ${d.externalRef ?? d.label}${f.channel ? ` (${f.channel})` : ""}${f.summary ? `: ${clip(f.summary, 80)}` : ""}`,
          });
    return events.sort((a, b) => a.at.localeCompare(b.at));
  };

  const tickets: RecapTicket[] = [];
  const add = (i: RecapIssue, group: ReportGroup) => {
    const deps = (depsBy.get(i.key) ?? []).map(dependencyOf);
    const notes: string[] = [];
    if (i.blockedBy.length) notes.push(`Blocked by ${i.blockedBy.slice(0, 3).join(", ")}`);
    if (i.dueDate && group !== "done") {
      const left = daysBetween(today, i.dueDate);
      notes.push(
        left < 0 ? `${-left} days past due (${shortDay(i.dueDate)})` : `Due ${shortDay(i.dueDate)}`,
      );
    }
    if (i.sprint && !input.activeSprints.has(i.sprint)) notes.push(`Sprint: ${i.sprint}`);
    else if (!i.sprint && group === "next") notes.push("Backlog");
    const epic = i.epicKey ? byKey.get(i.epicKey) : undefined;
    const ask = askBy.get(i.key);
    tickets.push({
      key: i.key,
      summary: i.summary,
      status: i.status,
      statusCategory: i.statusCategory,
      points: i.storyPoints,
      group,
      epic: i.epicKey ? { key: i.epicKey, name: epic?.summary ?? i.epicKey } : null,
      dueDate: i.dueDate,
      notes,
      events: eventsOf(i),
      dependencies: deps,
      waitingOnMe: ask ? `${ask.who}: ${ask.what}` : null,
      comments: (commentsBy.get(i.key) ?? []).slice(-COMMENTS_PER_TICKET).map((c) => ({
        by: who(c.author, c.authorDisplay, me),
        at: c.created,
        text: clip(c.body, COMMENT_CHARS),
      })),
    });
  };

  const scoped = input.issues.filter((i) => inScope(i) && !isEpic(i));
  const used = new Set<string>();
  const take = (list: RecapIssue[], group: ReportGroup) => {
    for (const i of list) {
      if (used.has(i.key)) continue;
      used.add(i.key);
      add(i, group);
    }
  };
  const byRecent = (a: RecapIssue, b: RecapIssue) => b.updated.localeCompare(a.updated);
  const activity = (i: RecapIssue) =>
    (input.history.get(i.key)?.length ?? 0) > 0 ||
    (commentsBy.get(i.key)?.length ?? 0) > 0 ||
    inWindow(i.updated);
  const assignedToMe = (i: RecapIssue) =>
    (input.history.get(i.key) ?? []).some((e) =>
      e.items.some((x) => x.field.toLowerCase() === "assignee" && x.toId === me),
    );
  const isBlocked = (i: RecapIssue) =>
    i.blockedBy.length > 0 ||
    /block|on hold/i.test(i.status) ||
    (depsBy.get(i.key) ?? []).some((d) => d.status === "blocked");

  // Done: resolved in the period.
  take(
    scoped
      .filter((i) => i.statusCategory === "done" && inWindow(i.resolved))
      .filter((i) => mine(i) || tracked.size > 0)
      .sort(byRecent),
    "done",
  );
  // New: created in the period, or assigned to me in it.
  take(
    scoped
      .filter((i) => i.statusCategory !== "done" && (inWindow(i.created) || assignedToMe(i)))
      .sort(byRecent),
    "new",
  );
  // Blocked: my open work waiting on something.
  take(
    scoped.filter((i) => mine(i) && i.statusCategory !== "done" && isBlocked(i)),
    "blocked",
  );
  // In progress: my started work, busiest first.
  take(
    scoped
      .filter((i) => mine(i) && i.statusCategory === "indeterminate")
      .sort((a, b) => Number(activity(b)) - Number(activity(a)) || byRecent(a, b))
      .slice(0, IN_PROGRESS_LIMIT),
    "in_progress",
  );
  // Changed: anything else in scope with history or comments in the period.
  take(
    scoped
      .filter((i) => !used.has(i.key) && i.statusCategory !== "done")
      .filter(
        (i) =>
          (input.history.get(i.key)?.length ?? 0) > 0 || (commentsBy.get(i.key)?.length ?? 0) > 0,
      )
      .sort(byRecent)
      .slice(0, CHANGED_LIMIT),
    "changed",
  );
  // Next: my to-do work, the active sprint's first, in focus order.
  const sprintFirst = (i: RecapIssue) => (i.sprint && input.activeSprints.has(i.sprint) ? 0 : 1);
  take(
    scoped
      .filter((i) => mine(i) && i.statusCategory === "new" && !i.isSubtask)
      .filter((i) => input.activeSprints.size === 0 || sprintFirst(i) === 0 || focusRank.has(i.key))
      .sort(
        (a, b) =>
          sprintFirst(a) - sprintFirst(b) ||
          (focusRank.get(a.key) ?? 999) - (focusRank.get(b.key) ?? 999) ||
          a.key.localeCompare(b.key),
      )
      .slice(0, NEXT_LIMIT),
    "next",
  );

  // Epic progress over all cached children, for the epics the tickets belong to.
  const epics: ReportEpic[] = [
    ...new Map(tickets.filter((t) => t.epic).map((t) => [t.epic?.key, t.epic])).values(),
  ]
    .filter((e): e is NonNullable<typeof e> => !!e)
    .map((e) => {
      const children = input.issues.filter((i) => i.epicKey === e.key && !i.isSubtask);
      return {
        key: e.key,
        name: e.name,
        done: children.filter((c) => c.statusCategory === "done").length,
        total: children.length,
      };
    });

  // Sprint health: the user's tickets in their active sprint.
  let sprint: SprintHealth | null = null;
  if (input.sprint) {
    const s = input.sprint;
    const inSprint = input.issues.filter(
      (i) => i.sprint === s.name && mine(i) && !i.isSubtask && !isEpic(i),
    );
    const pts = (list: RecapIssue[]) => list.reduce((n, i) => n + (i.storyPoints ?? 0), 0);
    const start = s.start?.slice(0, 10) ?? null;
    const end = s.end?.slice(0, 10) ?? null;
    const days = start && end ? workingDays(start, end) : null;
    const day =
      start && end ? Math.min(workingDays(start, today < end ? today : end), days ?? 0) : null;
    sprint = {
      name: s.name,
      endsOn: end,
      day,
      days,
      pointsDone: pts(inSprint.filter((i) => i.statusCategory === "done")),
      pointsTotal: pts(inSprint),
      pointsInReview: pts(
        inSprint.filter((i) => i.statusCategory !== "done" && /review/i.test(i.status)),
      ),
      pointsBlocked: pts(inSprint.filter((i) => i.statusCategory !== "done" && isBlocked(i))),
      unestimated: inSprint.filter((i) => i.storyPoints === null).map((i) => i.key),
    };
  }

  // Risks, from code: blocked sprint work, near due dates, pace behind time.
  const risks: string[] = [];
  const endsOn = sprint?.endsOn ? `${weekday(sprint.endsOn)} ${shortDay(sprint.endsOn)}` : null;
  for (const t of tickets) {
    const i = byKey.get(t.key);
    if (!i || i.statusCategory === "done") continue;
    if (t.group === "blocked" && i.sprint && input.activeSprints.has(i.sprint)) {
      const dep = t.dependencies[0];
      const on = dep
        ? ` on ${dep.externalRef ?? dep.label} (${dep.owner})`
        : i.blockedBy.length
          ? ` by ${i.blockedBy[0]}`
          : "";
      const long = dep?.since
        ? ` for ${Math.max(0, daysBetween(dep.since.slice(0, 10), today))} days`
        : "";
      risks.push(
        `${t.key}${t.points !== null ? ` (${t.points} pts)` : ""} is blocked${on}${long}${endsOn ? `; the sprint ends ${endsOn}` : ""}.`,
      );
    } else if (i.dueDate && daysBetween(today, i.dueDate) <= DUE_RISK_DAYS) {
      const left = daysBetween(today, i.dueDate);
      risks.push(
        `${t.key} is ${left < 0 ? `${-left} days past due` : left === 0 ? "due today" : `due ${shortDay(i.dueDate)}`} and ${i.statusCategory === "new" ? "not started" : `in ${i.status}`}.`,
      );
    }
    for (const d of t.dependencies)
      if (t.group !== "blocked" && d.overdueDays > 0)
        risks.push(
          `Waiting on ${d.owner} for ${t.key} is ${d.overdueDays} days past the expected date.`,
        );
  }
  if (sprint?.days && sprint.day && sprint.pointsTotal > 0) {
    const elapsed = sprint.day / sprint.days;
    const done = sprint.pointsDone / sprint.pointsTotal;
    if (done + 0.2 < elapsed)
      risks.push(
        `${sprint.pointsDone} of ${sprint.pointsTotal} points done with ${sprint.days - sprint.day} working day${sprint.days - sprint.day === 1 ? "" : "s"} left in ${sprint.name}.`,
      );
  }

  const scopedKeys = new Set(scoped.map((i) => i.key));
  const doneTickets = tickets.filter((t) => t.group === "done");
  return {
    tickets,
    epics,
    sprint,
    risks,
    asks: [...asks.values()].sort((a, b) => a.at.localeCompare(b.at)),
    stats: {
      done: doneTickets.length,
      pointsDone: doneTickets.reduce((n, t) => n + (t.points ?? 0), 0),
      inProgress: tickets.filter((t) => t.group === "in_progress").length,
      new: tickets.filter((t) => t.group === "new").length,
      comments: input.comments.filter((c) => scopedKeys.has(c.issueKey)).length,
    },
  };
}

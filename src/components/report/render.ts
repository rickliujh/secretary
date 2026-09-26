/**
 * A report as Markdown in one of four styles (D39). Every style is built from
 * the same report data, so switching styles never asks the model again. Ticket
 * keys stay plain ("PAY-412") so `<Markdown linkTickets>` links them; text from
 * Jira or the model is escaped so it cannot turn into Markdown syntax. Dates and
 * times are local: "Thu 24 Sep", "16:10".
 */
import type {
  Report,
  ReportDependency,
  ReportEvent,
  ReportGroup,
  ReportStyle,
  ReportTicket,
} from "@/services/report";

export const STYLE_LABELS: Record<ReportStyle, string> = {
  talk_track: "Talk track",
  standup: "Stand-up",
  by_epic: "By epic",
  timeline: "Timeline",
};

/** Tickets are listed in this order of group, then as the report lists them. */
const GROUP_ORDER: ReportGroup[] = ["done", "in_progress", "blocked", "new", "changed", "next"];

const DAY_MS = 24 * 3600 * 1000;

// ---- dates -------------------------------------------------------------

/** A date-only string ("2026-09-24") is local midnight, not UTC. */
const toDate = (s: string) => new Date(s.length === 10 ? `${s}T00:00:00` : s);

// Fixed English names: the report's prose is English, and ICU data differs ("Sep" or "Sept").
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const weekday = (s: string) => WEEKDAYS[toDate(s).getDay()];
/** "24 Sep" */
const dayMonth = (s: string) => {
  const d = toDate(s);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
};
/** "Thu 24 Sep" */
const day = (s: string) => `${weekday(s)} ${dayMonth(s)}`;
/** "16:10" */
const clock = (s: string) => {
  const d = toDate(s);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

const midnight = (s: string) => {
  const d = toDate(s);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Whole calendar days from `a` to `b`. */
const daysBetween = (a: string, b: string) => Math.round((midnight(b) - midnight(a)) / DAY_MS);

/** "19–26 Sep", "30 Sep–2 Oct", or one day. */
function range(since: string, until: string): string {
  const a = toDate(since);
  const b = toDate(until);
  if (daysBetween(since, until) === 0) return dayMonth(until);
  if (a.getMonth() === b.getMonth() && a.getFullYear() === b.getFullYear())
    return `${a.getDate()}–${dayMonth(until)}`;
  return `${dayMonth(since)}–${dayMonth(until)}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pts = (n: number) => plural(n, "pt", "pts");
/** "today", "1 day", "3 days" */
const age = (from: string, until: string) => {
  const n = Math.max(daysBetween(from, until), 0);
  return n === 0 ? "today" : plural(n, "day");
};

// ---- text --------------------------------------------------------------

/**
 * Text from Jira or the model as literal Markdown text: whitespace collapsed,
 * emphasis, code, link and HTML syntax escaped, and nothing at the start that
 * would make a heading, list or quote. Keeps "->" and snake_case readable.
 */
export function esc(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\`*[\]~]/g, "\\$&")
    .replace(/(^|[^A-Za-z0-9])_|_(?=[^A-Za-z0-9]|$)/g, (m) => m.replace("_", "\\_"))
    .replace(/<(?=[A-Za-z/!?])/g, "\\<")
    .replace(/^[#>+-]/, "\\$&")
    .replace(/^(\d+)(?=[.)])/, "$1\\");
}

/** Model prose: paragraphs kept, each escaped. */
const prose = (text: string) =>
  text
    .split(/\n\s*\n/)
    .map(esc)
    .filter(Boolean)
    .join("\n\n");

/** Ends a sentence unless it already ends in punctuation. */
const sentence = (s: string) => (/[.!?:]$/.test(s) ? s : `${s}.`);
const lcFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const ucFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "me" for the user, in first-person lines. */
const who = (by: string) => (by === "you" ? "me" : by);

/** Event text written by code, with the user as "me" ("Assigned to you" -> "Assigned to me"). */
const codeText = (e: ReportEvent) =>
  e.kind === "comment" || e.kind === "followup" ? e.text : e.text.replace(/\byou\b/g, "me");

// ---- blocks --------------------------------------------------------------

const heading = (level: 2 | 3, text: string) => `${"#".repeat(level)} ${text}`;
const bullets = (lines: string[]) => lines.map((l) => `- ${l}`).join("\n");
/** A `###` section with bullets, or nothing when there are no lines. */
const section = (title: string, lines: string[]) =>
  lines.length ? `${heading(3, title)}\n\n${bullets(lines)}` : "";
const join = (blocks: string[]) => blocks.filter(Boolean).join("\n\n");

const EMPTY = "No ticket activity in this period.";

// ---- ticket facts ------------------------------------------------------

const ordered = (tickets: ReportTicket[]) =>
  GROUP_ORDER.flatMap((g) => tickets.filter((t) => t.group === g));

const isBlocked = (t: ReportTicket) =>
  t.group === "blocked" || t.dependencies.some((d) => d.status === "blocked");

const icon = (t: ReportTicket) =>
  isBlocked(t)
    ? "⚠"
    : t.statusCategory === "done"
      ? "✓"
      : t.statusCategory === "indeterminate"
        ? "◐"
        : "·";

/** "PAY-412 Refund rounding" */
const title = (t: ReportTicket) => (t.summary.trim() ? `${t.key} ${esc(t.summary)}` : t.key);

/** Who created the ticket, when it was someone else and it happened in the period. */
const creator = (t: ReportTicket) => {
  const by = t.events.find((e) => e.kind === "created")?.by;
  return by && by !== "you" && by !== "someone" ? by : null;
};

/** "due 2 Oct", "2 pts" */
const meta = (t: ReportTicket) => [
  ...(t.dueDate ? [`due ${dayMonth(t.dueDate)}`] : []),
  ...(t.points !== null ? [pts(t.points)] : []),
];

/** The status, event and field changes worth a line (not comments or follow-ups). */
const changes = (t: ReportTicket) => {
  const hasStatus = t.events.some((e) => e.kind === "status");
  return t.events.filter(
    (e) =>
      e.kind === "created" ||
      e.kind === "assigned" ||
      e.kind === "status" ||
      e.kind === "field" ||
      (e.kind === "resolved" && !hasStatus),
  );
};

const DEFAULT_TEXT: Record<ReportEvent["kind"], string> = {
  created: "Created",
  assigned: "Assigned",
  status: "Status changed",
  field: "Changed",
  comment: "Commented",
  resolved: "Resolved",
  followup: "Followed up",
};

const eventText = (e: ReportEvent) => esc(codeText(e)) || DEFAULT_TEXT[e.kind];

/** "In Review -> Done Thu 16:10 (me)" */
const changeLine = (e: ReportEvent, until: string) =>
  `${ucFirst(eventText(e))} ${stamp(e.at, until)} (${who(e.by)})`;

/** "Thu 16:10" within the last week, "24 Sep 16:10" before. */
const stamp = (at: string, until: string) =>
  `${daysBetween(at, until) < 7 ? weekday(at) : dayMonth(at)} ${clock(at)}`;

/** The dependency's lines under a ticket in the details. */
function dependencyLines(d: ReportDependency, until: string): string[] {
  const what = d.externalRef ? `${esc(d.label)} ${esc(d.externalRef)}` : esc(d.label);
  const verb = d.status === "blocked" ? "Blocked on" : "Waiting on";
  const timing = [
    ...(d.since ? [`since ${day(d.since)} (${age(d.since, until)})`] : []),
    ...(d.expectedAt ? [`expected ${day(d.expectedAt)}`] : []),
    ...(d.overdueDays > 0 ? [`${plural(d.overdueDays, "day")} overdue`] : []),
  ];
  const chase = [
    ...(d.lastFollowup
      ? [
          `last chased ${day(d.lastFollowup.at)}${d.lastFollowup.channel ? ` on ${esc(d.lastFollowup.channel)}` : ""}${d.lastFollowup.summary ? `: ${esc(d.lastFollowup.summary)}` : ""}`,
        ]
      : []),
    ...(d.followupDue
      ? ["follow-up due today"]
      : d.nextFollowupAt
        ? [`next follow-up ${day(d.nextFollowupAt)}`]
        : []),
  ];
  return [
    `${verb} ${esc(d.owner)}: ${what}`,
    ...(timing.length ? [ucFirst(timing.join(", "))] : []),
    ...(chase.length ? [ucFirst(chase.join("; "))] : []),
  ];
}

/** "blocked 3 days on OPS-77 (Network (Priya)); follow-up due today" */
function dependencyBrief(d: ReportDependency, until: string): string {
  const verb = d.status === "blocked" ? "blocked" : "waiting";
  const time = d.since ? ` ${plural(Math.max(daysBetween(d.since, until), 0), "day")}` : "";
  const on = esc(d.externalRef ?? d.label);
  return `${verb}${time} on ${on} (${esc(d.owner)})${d.followupDue ? "; follow-up due today" : ""}`;
}

const askLine = (a: Report["asks"][number]) => `${esc(a.who)} on ${a.key}: ${esc(a.what)}`;

/** "Payments 15 (ends Mon 28 Sep)" */
const sprintName = (s: NonNullable<Report["sprint"]>) =>
  s.endsOn ? `${esc(s.name)} (ends ${day(s.endsOn)})` : esc(s.name);

/** "13/21 pts done · 5 in review · 3 blocked", with the share done when asked. */
const sprintPoints = (s: NonNullable<Report["sprint"]>, percent = false) =>
  [
    `${s.pointsDone}/${s.pointsTotal} pts done${percent && s.pointsTotal > 0 ? ` (${Math.round((s.pointsDone / s.pointsTotal) * 100)}%)` : ""}`,
    ...(s.pointsInReview > 0 ? [`${s.pointsInReview} in review`] : []),
    ...(s.pointsBlocked > 0 ? [`${s.pointsBlocked} blocked`] : []),
  ].join(" · ");

const unestimated = (s: NonNullable<Report["sprint"]>) =>
  s.unestimated.length
    ? [`${plural(s.unestimated.length, "ticket")} unestimated (${s.unestimated.join(", ")})`]
    : [];

// ---- styles --------------------------------------------------------------

/** A script to read out, then the facts per ticket. */
function talkTrack(r: Report): string {
  const tickets = ordered(r.tickets).map((t) => {
    const status = t.group === "new" ? "NEW" : t.group === "blocked" ? "BLOCKED" : t.status;
    const head = [`**${title(t)}**`, esc(status.toUpperCase()), ...meta(t)].join(" · ");
    const lines = [
      ...changes(t).map((e) => changeLine(e, r.until)),
      ...(t.happened.trim() ? [esc(t.happened)] : []),
      ...t.dependencies.flatMap((d) => dependencyLines(d, r.until)),
      ...(t.waitingOnMe ? [`Waiting on me: ${esc(t.waitingOnMe)}`] : []),
      ...(t.next.trim() ? [`Next: ${esc(t.next)}`] : []),
    ];
    return lines.length ? `${head}\n${bullets(lines)}` : head;
  });
  const s = r.sprint;
  return join([
    heading(2, `Update since ${day(r.since)}${s ? ` · ${sprintName(s)}` : ""}`),
    r.talkTrack.trim() ? `${heading(3, "Say this")}\n\n${prose(r.talkTrack)}` : "",
    tickets.length ? `${heading(3, "Details")}\n\n${tickets.join("\n\n")}` : "",
    section(
      "Waiting on me",
      r.asks.map((a) => `${askLine(a)} (${age(a.at, r.until)})`),
    ),
    section("Risks", r.risks.map(esc).filter(Boolean)),
    s ? section(`Sprint ${esc(s.name)}`, [sprintPoints(s), ...unestimated(s)]) : "",
    r.tickets.length === 0 && r.asks.length === 0 && !r.talkTrack.trim() ? EMPTY : "",
  ]);
}

/** What moved on a ticket in the period, for the stand-up's first section. */
function activity(t: ReportTicket, r: Report, timeOnly: boolean): string {
  const when = (at: string) => (timeOnly ? clock(at) : stamp(at, r.until));
  const status = t.events.filter((e) => e.kind === "status").at(-1);
  const parts = [
    ...t.events
      .filter((e) => e.kind !== "comment" && e.kind !== "status")
      .filter((e) => e.kind !== "resolved" || !status)
      .map((e) => {
        switch (e.kind) {
          case "created":
            return e.by === "you" ? "created" : `created by ${esc(e.by)}`;
          case "resolved":
            return `resolved at ${when(e.at)}`;
          case "followup":
            return lcFirst(esc(e.text)) || "followed up";
          default:
            return lcFirst(eventText(e));
        }
      }),
    ...(status
      ? [
          status.text.includes("->")
            ? `moved to ${esc(status.text.split("->").at(-1) ?? "")} at ${when(status.at)}`
            : `${lcFirst(eventText(status))} at ${when(status.at)}`,
        ]
      : []),
    ...(t.happened.trim() ? [esc(t.happened)] : []),
  ];
  if (!parts.length) return "";
  const done = t.statusCategory === "done" && t.points !== null ? ` (${pts(t.points)})` : "";
  return `${title(t)}: ${sentence(parts.join("; "))}${done}`;
}

/** Yesterday (or the period), today, blockers. */
function standup(r: Report): string {
  const tickets = ordered(r.tickets);
  const sinceYesterday = r.periodLabel === "Since yesterday";
  const short = daysBetween(r.since, r.until) <= 6;
  const doneLines = tickets
    .map((t) => [t.key, activity(t, r, daysBetween(r.since, r.until) <= 1)] as const)
    .filter(([, line]) => line);
  const mentioned = new Set(doneLines.map(([key]) => key));
  const today = [
    ...tickets
      .filter((t) => t.next.trim())
      .map((t) => {
        const from = creator(t);
        // New work gets its size; known work only its due date.
        const facts =
          t.group === "new"
            ? [from ? `new from ${esc(from)}` : "new", ...meta(t)]
            : t.dueDate
              ? [`due ${dayMonth(t.dueDate)}`]
              : [];
        const name = mentioned.has(t.key) ? t.key : title(t);
        return `${name}${facts.length ? ` (${facts.join(", ")})` : ""}: ${sentence(esc(t.next))}`;
      }),
    // An ask on a ticket that already has a next step is covered by that step.
    ...r.asks
      .filter((a) => !r.tickets.some((t) => t.key === a.key && t.next.trim()))
      .map((a) => `Answer ${sentence(askLine(a))}`),
  ];
  const blockers = tickets.filter(isBlocked).flatMap((t) => {
    if (!t.dependencies.length) {
      const why = t.notes.map(esc).filter(Boolean).join("; ");
      return [`${title(t)}: ${why ? sentence(why) : "blocked."}`];
    }
    return t.dependencies.map((d) => {
      const ref = d.externalRef ? `${esc(d.externalRef)} ` : "";
      const timing = [
        ...(d.since ? [`Open ${age(d.since, r.until)}`] : []),
        ...(d.overdueDays > 0
          ? [`${plural(d.overdueDays, "day")} past expected date`]
          : d.expectedAt
            ? [`expected ${day(d.expectedAt)}`]
            : []),
      ].join(", ");
      return [
        `${t.key} waits on ${ref}${esc(d.label)}, owner ${esc(d.owner)}.`,
        ...(timing ? [`${timing}.`] : []),
        ...(d.followupDue ? ["Follow-up due today."] : []),
      ].join(" ");
    });
  });
  const s = r.sprint;
  return join([
    heading(
      2,
      `Stand-up · ${day(r.until)} (since ${short ? weekday(r.since) : dayMonth(r.since)})`,
    ),
    section(
      sinceYesterday ? "Yesterday" : esc(r.periodLabel),
      doneLines.map(([, l]) => l),
    ),
    section("Today", today),
    section("Blockers", blockers),
    s
      ? `${heading(3, "Sprint")}\n\n${esc(s.name)}: ${s.pointsDone} of ${s.pointsTotal} pts done${s.endsOn ? `, ends ${day(s.endsOn)}` : ""}.`
      : "",
    section("Risks", r.risks.map(esc).filter(Boolean)),
    r.tickets.length === 0 && r.asks.length === 0 ? EMPTY : "",
  ]);
}

/** Headline, sprint health, then the tickets under their epics. */
function byEpic(r: Report): string {
  const s = r.sprint;
  const done = r.tickets.filter((t) => t.group === "done");
  const donePoints = done.reduce((n, t) => n + (t.points ?? 0), 0);
  const health = s
    ? section(
        `Sprint health: ${esc(s.name)}${s.day !== null && s.days !== null ? ` · day ${s.day} of ${s.days}` : ""}`,
        [
          `Points: ${sprintPoints(s, true)}`,
          ...(done.length
            ? [
                `Done this period: ${plural(done.length, "ticket")}${donePoints ? `, ${pts(donePoints)}` : ""}`,
              ]
            : []),
          ...(s.unestimated.length ? [`Unestimated: ${s.unestimated.join(", ")}`] : []),
        ],
      )
    : "";

  const epicKeys = [
    ...r.epics.map((e) => e.key),
    ...r.tickets.flatMap((t) => (t.epic ? [t.epic.key] : [])),
  ].filter((k, i, all) => all.indexOf(k) === i);
  const line = (t: ReportTicket) => {
    const blocked = isBlocked(t) && t.dependencies[0];
    const detail = blocked
      ? dependencyBrief(blocked, r.until)
      : esc(t.happened) || esc(t.next) || (isBlocked(t) ? t.notes.map(esc).join("; ") : "");
    const status = t.statusCategory === "done" ? "" : ` · ${esc(t.status)}`;
    return `${icon(t)} ${title(t)}${status}${detail ? `: ${detail}` : ""}`;
  };
  const group = (head: string, tickets: ReportTicket[]) =>
    tickets.length ? `${head}\n${bullets(ordered(tickets).map(line))}` : "";
  const epics = [
    ...epicKeys.map((key) => {
      const tickets = r.tickets.filter((t) => t.epic?.key === key);
      const progress = r.epics.find((e) => e.key === key);
      const name = progress?.name ?? r.tickets.find((t) => t.epic?.key === key)?.epic?.name ?? "";
      const count = progress ? ` · ${progress.done}/${progress.total} done` : "";
      return group(`**${key}${name.trim() ? ` ${esc(name)}` : ""}**${count}`, tickets);
    }),
    group(
      "**No epic**",
      r.tickets.filter((t) => !t.epic),
    ),
  ].filter(Boolean);

  const created = r.tickets
    .filter((t) => t.group === "new")
    .map((t) => {
      const from = creator(t);
      return `${title(t)}${from ? ` from ${esc(from)}` : ""}${t.dueDate ? ` (due ${dayMonth(t.dueDate)})` : ""}`;
    });

  return join([
    heading(2, `Catch-up · ${esc(r.periodLabel)} (${range(r.since, r.until)})`),
    r.headline.trim() ? `${heading(3, "Headline")}\n\n${esc(r.headline)}` : "",
    health,
    epics.length ? `${heading(3, "By epic")}\n\n${epics.join("\n\n")}` : "",
    section("Risks", r.risks.map(esc).filter(Boolean)),
    section(
      "Decisions and asks",
      r.asks.map((a) => `${askLine(a)} (open ${age(a.at, r.until)})`),
    ),
    section("New this period", created),
    r.tickets.length === 0 && r.asks.length === 0 ? EMPTY : "",
  ]);
}

/** One event on the timeline, without its time. */
function timelineText(t: ReportTicket, e: ReportEvent): string {
  switch (e.kind) {
    case "comment":
      return `${t.key} ${esc(who(e.by))}: ${esc(e.text) || "commented"}`;
    case "followup":
      return `${t.key} follow-up: ${esc(e.text) || "chased"} (${who(e.by)})`;
    case "created":
    case "assigned":
    case "resolved":
      return `${t.key} ${lcFirst(eventText(e))} (${who(e.by)})`;
    default:
      return `${t.key} ${eventText(e)} (${who(e.by)})`;
  }
}

/** Every event, newest day first, then what is open now. */
function timeline(r: Report): string {
  const events = r.tickets
    .flatMap((t) => t.events.map((e) => ({ t, e, ms: toDate(e.at).getTime() })))
    .sort((a, b) => a.ms - b.ms);
  const days = new Map<number, typeof events>();
  for (const x of events) {
    const key = midnight(x.e.at);
    days.set(key, [...(days.get(key) ?? []), x]);
  }
  const dayBlocks = [...days.entries()]
    .sort(([a], [b]) => b - a)
    .map(([, xs]) =>
      section(
        day(xs[0]?.e.at ?? r.until),
        xs.map(({ t, e }) => `${clock(e.at)} ${timelineText(t, e)}`),
      ),
    );
  const open = ordered(r.tickets)
    .filter((t) => t.statusCategory !== "done")
    .map((t) => {
      const dep = isBlocked(t) ? t.dependencies[0] : undefined;
      const facts = [esc(t.status), ...meta(t)].join(", ");
      const detail = dep ? dependencyBrief(dep, r.until) : esc(t.next);
      return `${icon(t)} ${title(t)} · ${facts}${detail ? `: ${detail}` : ""}`;
    });
  const s = r.sprint;
  return join([
    heading(2, `${esc(r.periodLabel)} · ${range(r.since, r.until)}`),
    ...dayBlocks,
    section("Open now", open),
    section("Waiting on me", r.asks.map(askLine)),
    section("Risks", r.risks.map(esc).filter(Boolean)),
    s
      ? `${heading(3, "Sprint")}\n\n${esc(s.name)}: ${s.pointsDone}/${s.pointsTotal} pts${s.endsOn ? ` · ends ${day(s.endsOn)}` : ""}`
      : "",
    r.tickets.length === 0 && r.asks.length === 0 ? EMPTY : "",
  ]);
}

const STYLES: Record<ReportStyle, (r: Report) => string> = {
  talk_track: talkTrack,
  standup,
  by_epic: byEpic,
  timeline,
};

/** The report as Markdown in the chosen style. */
export const renderReport = (report: Report, style: ReportStyle): string => STYLES[style](report);

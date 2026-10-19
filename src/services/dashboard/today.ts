/**
 * Today (FR-12, D49): one place to look. `buildToday` is pure over one
 * snapshot of the local cache and returns three lists, one per question:
 *
 * - Your move: what waits on the user (outcome cards, woken tickets, small
 *   asks, new comments and mentions, Inbox threads with decisions).
 * - Their move: what the user waits on (open dependencies, and the user's
 *   tickets blocked by an open ticket).
 * - Sprint work: the planned work (Top focus, D29) with due-soon and at-risk
 *   tickets joined in as badges.
 */
import { daysBetween, localDateOf } from "@/lib/dates";
import type { WokenTicket } from "@/services/blockers/logic";
import { type DependencyTiming, timing } from "@/services/dependencies/logic";
import type { ScoringWeights } from "@/services/settings/schema";
import { userActiveSprints } from "@/services/sprints/active";
import type { SprintInfo } from "@/services/sprints/calendar";
import type { OutcomeRef } from "@/services/work/outcomes";
import {
  blockInfo,
  type DashboardInputs,
  type DashDependency,
  type DashIssue,
  FACT_LIMIT,
  type Flagged,
  type FocusItem,
  type FocusScope,
  rankWork,
  TOP_FOCUS_LIMIT,
} from "./sections";

/** An Inbox thread with proposals or questions waiting for the user (D22). */
export type InboxThread = {
  id: string;
  summary: string | null;
  sender: string | null;
  /** Proposals to approve. */
  proposals: number;
  /** Questions to answer. */
  questions: number;
  /** When the oldest of them was made. */
  since: string;
};

export type TodayInputs = DashboardInputs & {
  /** Tickets whose last blocker closed (D45), as `loadWokenTickets` lists them. */
  woken: readonly WokenTicket[];
  threads: readonly InboxThread[];
  /** The small-asks home's label (D44); null while no home is set. */
  smallAskLabel: string | null;
  /** The active work item of each ticket (D61), so rows name it. */
  workItems?: ReadonlyMap<string, WorkItemRef>;
  /** Open outcome cards (Phase 25); their tickets' plain wait, woken and comment rows are hidden. */
  outcomes?: readonly OutcomeRef[];
};

/** The work item a row's ticket belongs to (D61); `current`: the user is on it. */
export type WorkItemRef = { id: string; name: string; current: boolean };

/** A ticket waiting on the user. */
export type TicketRow = {
  workItem?: WorkItemRef;
  kind: "woken" | "ask" | "comment";
  issue: DashIssue;
  /** Why it is here, in a few words: the wake reason, "Dana commented", "asked by Priya 3 days ago". */
  reason: string;
  /** When it came up: woken, commented on, or created. */
  at: string;
  /** Carries the home's label (D44). */
  smallAsk: boolean;
  /** The comment a comment row is for, when known. */
  commentId?: string;
};

export type ThreadRow = {
  kind: "thread";
  thread: InboxThread;
  reason: string;
  workItem?: WorkItemRef;
};

/** An outcome card (Phase 25): the follow-ups a changed fact calls for, approved in one click. */
export type OutcomeRow = {
  kind: "outcome";
  outcome: OutcomeRef;
  reason: string;
  workItem?: WorkItemRef;
};

export type YourMoveRow = TicketRow | ThreadRow | OutcomeRow;

/** Where a wait stands, in Their move's order (D49). */
export type WaitState = "overdue" | "followup" | "back" | "open" | "asleep";
const WAIT_ORDER: readonly WaitState[] = ["overdue", "followup", "back", "open", "asleep"];

export type WaitRow = {
  workItem?: WorkItemRef;
  kind: "wait";
  dependency: DashDependency;
  timing: DependencyTiming;
  state: WaitState;
  /**
   * The next chase is set for a later day ("chase later"): an overdue wait then
   * keeps its state and badge but is listed with the rest, and the sweep skips
   * it until that day (D49).
   */
  decided: boolean;
  reason: string;
  /** The ticket the wait is on, when cached. */
  issue: DashIssue | null;
};

export type BlockedRow = {
  workItem?: WorkItemRef;
  kind: "blocked";
  issue: DashIssue;
  /** Open blockers. */
  blockedBy: string[];
  reason: string;
  /** Snoozed: listed last with the sleeping waits. */
  asleep: boolean;
};

export type TheirMoveRow = WaitRow | BlockedRow;

/** An open small ask and where it stands ("your move", "waiting on Bob: numbers", "snoozed until 7 Oct"). */
export type SmallAskState = { issue: DashIssue; state: string };

export type SprintRow = {
  workItem?: WorkItemRef;
  issue: FocusItem;
  reason: string;
  /** One of the ten ranked first (Top focus); else joined in for being due soon or at risk. */
  inFocus: boolean;
  /** Days to the due date when due within a week or late; else null. */
  daysLeft: number | null;
  /** At-risk reasons; empty when not at risk. */
  risks: string[];
};

/** What the brief and the chat tools read: the ranking's lists, cut to size. */
export type TodayFacts = {
  topFocus: FocusItem[];
  dueSoon: (DashIssue & { daysLeft: number })[];
  atRisk: Flagged[];
  waitingOnMe: (Flagged & { at: string })[];
};

export type Today = {
  yourMove: YourMoveRow[];
  theirMove: TheirMoveRow[];
  sprintWork: SprintRow[];
  focus: FocusScope;
  /** The end (YYYY-MM-DD) of the active sprint holding most of the user's work, for "snooze until after the sprint". */
  sprintEnd: string | null;
  /**
   * Every open ticket of the user's blocked by an open ticket, wherever the
   * lists placed it (a new comment puts one in Your move), with snoozed ones
   * marked asleep; for the chat's `waiting_on`.
   */
  blocked: BlockedRow[];
  /** Open tickets in scope that are snoozed now. */
  snoozed: number;
  inScope: number;
  smallAsks: {
    /** Whether a home is set (D44); without one Your move has no asks and links to the setting. */
    home: boolean;
    /** The user's open small asks wherever they are, oldest first, with where each stands. */
    open: SmallAskState[];
  };
  facts: TodayFacts;
};

/** At most this many due-soon or at-risk tickets are joined into Sprint work beyond Top focus. */
export const SPRINT_EXTRA_LIMIT = 10;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "14 Oct" / "Friday" for a YYYY-MM-DD date, in the same English as the wait reasons. */
const dayMonth = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
const weekday = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });

/** "due today", "due tomorrow", "due Friday", "due 14 Oct", "2 days late". */
export function dueLabel(due: string, today: string): string {
  const left = daysBetween(today, due);
  if (left < 0) return `${plural(-left, "day")} late`;
  if (left === 0) return "due today";
  if (left === 1) return "due tomorrow";
  if (left < 7) return `due ${weekday(due)}`;
  return `due ${dayMonth(due)}`;
}

/** "today", "yesterday", "3 days ago" for a date or ISO time. */
export function agoLabel(at: string, today: string): string {
  const n = Math.max(0, daysBetween(localDateOf(at), today));
  return n === 0 ? "today" : n === 1 ? "yesterday" : `${n} days ago`;
}

/** A small ask's reason: when it is due, and who asked and when. */
function askReason(i: DashIssue, today: string): string {
  const asked = i.requester
    ? `asked by ${i.requester.name} ${agoLabel(i.created, today)}`
    : `added ${agoLabel(i.created, today)}`;
  return i.dueDate ? `${dueLabel(i.dueDate, today)}, ${asked}` : asked;
}

/**
 * Whether a wait's next chase is set for a day after `today` with nothing due
 * now: the user decided to chase later (D49).
 */
export const chaseDecided = (t: DependencyTiming, today: string) =>
  !t.followupDue && !!t.followupOn && t.followupOn > today;

/** The waits whose follow-up is due on Today, leaving out sleeping ones (a snoozed ticket's too). */
export const dueWaits = (t: Pick<Today, "theirMove">): WaitRow[] =>
  t.theirMove.filter(
    (r): r is WaitRow => r.kind === "wait" && r.state !== "asleep" && r.timing.followupDue,
  );

/**
 * The day a wait's "chase later" must be after, besides today: the day its
 * owner is back while they are away or just back (D47). A next chase on or
 * before that day changes nothing, since "is back" decides then.
 */
export const waitSnoozeAfter = (t: DependencyTiming): string | null =>
  t.asleep || t.backSince ? t.followupOn : null;

/** A wait's state on `today` (D47, D49). A wait on a snoozed ticket sleeps with it. */
export function waitState(t: DependencyTiming, ticketSnoozed: boolean): WaitState {
  if (t.asleep || ticketSnoozed) return "asleep";
  if (t.overdueDays > 0) return "overdue";
  if (t.followupDue && !t.backSince) return "followup";
  if (t.backSince) return "back";
  return "open";
}

function waitReason(
  d: DashDependency,
  t: DependencyTiming,
  state: WaitState,
  snoozedUntil: string | null,
  today: string,
): string {
  switch (state) {
    case "overdue":
      return chaseDecided(t, today) && t.followupOn
        ? `${plural(t.overdueDays, "day")} overdue, next chase ${dueLabel(t.followupOn, today).replace(/^due /, "")}`
        : `${plural(t.overdueDays, "day")} overdue`;
    case "followup":
      return t.followupLateDays > 0
        ? `follow-up ${plural(t.followupLateDays, "day")} late`
        : "follow-up due today";
    case "back":
      return t.reason ?? `${d.ownerName} is back`;
    case "asleep":
      return t.asleep
        ? (t.reason ?? `${d.ownerName} is away`)
        : `ticket snoozed${snoozedUntil ? ` until ${dayMonth(localDateOf(snoozedUntil))}` : ""}`;
    case "open":
      if (d.expectedAt) return `expected ${dueLabel(d.expectedAt, today).replace(/^due /, "")}`;
      if (t.followupOn) return `next chase ${dueLabel(t.followupOn, today).replace(/^due /, "")}`;
      return "waiting";
  }
}

/** Where a wait is listed: by its state, except that a decided one is with the rest (D49). */
const waitRank = (r: WaitRow) =>
  WAIT_ORDER.indexOf(r.decided && r.state !== "asleep" ? "open" : r.state);

/** Orders waits: by rank, then the most pressing first within it. */
function compareWaits(a: WaitRow, b: WaitRow): number {
  const s = waitRank(a) - waitRank(b);
  if (s) return s;
  if (a.state === "overdue" && b.state === "overdue" && !a.decided && !b.decided)
    return b.timing.overdueDays - a.timing.overdueDays;
  if (a.state === "followup" && b.state === "followup")
    return b.timing.followupLateDays - a.timing.followupLateDays;
  // Owner back: longest back first; sleeping: soonest to wake first; the rest: soonest expected.
  const when = (r: WaitRow) =>
    (r.state === "back"
      ? r.timing.backSince
      : r.state === "asleep"
        ? r.timing.asleep
          ? r.timing.followupOn
          : r.issue?.snoozedUntil && localDateOf(r.issue.snoozedUntil)
        : (r.dependency.expectedAt ?? r.timing.followupOn)) || "9999";
  return when(a).localeCompare(when(b)) || a.dependency.label.localeCompare(b.dependency.label);
}

/** One entry per Inbox thread from its pending proposals, oldest first. */
export function groupThreads(
  rows: readonly {
    inboxItemId: string;
    kind: string;
    createdAt: string;
    summary: string | null;
    sender: string | null;
  }[],
): InboxThread[] {
  const byId = new Map<string, InboxThread>();
  for (const r of rows) {
    const t = byId.get(r.inboxItemId) ?? {
      id: r.inboxItemId,
      summary: r.summary,
      sender: r.sender,
      proposals: 0,
      questions: 0,
      since: r.createdAt,
    };
    if (r.kind === "needs_clarification") t.questions++;
    else t.proposals++;
    if (r.createdAt < t.since) t.since = r.createdAt;
    byId.set(r.inboxItemId, t);
  }
  return [...byId.values()].sort((a, b) => a.since.localeCompare(b.since));
}

function threadReason(t: InboxThread, today: string): string {
  const what = [
    t.proposals ? `${t.proposals} to approve` : null,
    t.questions ? plural(t.questions, "question") : null,
  ]
    .filter(Boolean)
    .join(", ");
  const days = Math.max(0, daysBetween(localDateOf(t.since), today));
  return `${what}, ${days === 0 ? "new today" : `waiting ${plural(days, "day")}`}`;
}

/** Whether an issue carries the small-asks label; Jira labels are compared without case. */
const hasLabel = (i: DashIssue, label: string | null) =>
  !!label && i.labels.some((l) => l.toLowerCase() === label.toLowerCase());

/**
 * The three lists of Today. A ticket appears in one list only; the first rule
 * that matches places it:
 *
 * 1. Woken (D45): its last blocker closed in the last week and the user has not
 *    looked since. Your move.
 * 2. Snoozed: in no list (a blocked one sleeps at the end of Their move, and a
 *    wait on it sleeps too). Counted.
 * 3. A comment or mention by someone else since the user last looked at it.
 *    Your move, even when blocked or a small ask: someone is waiting for an answer.
 * 4. The user's ticket blocked by an open ticket. Their move.
 * 5. The user's open small ask (home label): Your move, unless it has an open
 *    wait, which then stands for it in Their move.
 * 6. Anything else in scope: Sprint work, when ranked into Top focus or due
 *    soon or at risk. Small asks are never Sprint work.
 *
 * Waits are rows of their own, not tickets: a wait is always in Their move,
 * and the ticket it is on keeps its own place.
 */
export function buildToday(
  input: TodayInputs,
  weights: ScoringWeights,
  today: string,
  now: string,
): Today {
  const work = rankWork(input, weights, today, now);
  const me = input.me;
  const byKey = new Map(input.issues.map((i) => [i.key, i]));
  const label = input.smallAskLabel;
  const isAsk = (i: DashIssue) => hasLabel(i, label);
  const snoozedNow = (i: DashIssue | null | undefined) => !!i?.snoozedUntil && i.snoozedUntil > now;
  const open = (i: DashIssue | undefined): i is DashIssue => !!i && i.statusCategory !== "done";
  const mine = (i: DashIssue) => me !== null && i.assignee === me;
  const openWaits = input.dependencies.filter((d) => d.status !== "resolved");
  const waitedOn = new Set(openWaits.map((d) => d.issueKey));
  const placed = new Set<string>();
  /** Where each small ask was placed, for `smallAsks.open`. */
  const askState = new Map<string, string>();
  const items = input.workItems ?? new Map<string, WorkItemRef>();

  // 0. An outcome card stands for what it is about, and only that: the waits it
  // names, a woken ticket a blocker card resumes, the comments a teammate card is about.
  const outcomes = input.outcomes ?? [];
  const cardWaits = new Set(outcomes.flatMap((o) => o.waits));
  const cardWoken = new Set(
    outcomes.filter((o) => o.rule === "blocker_closed").flatMap((o) => o.keys),
  );
  const cardComments = new Set(
    outcomes.filter((o) => o.rule === "teammate_touched").flatMap((o) => o.comments),
  );
  const outcomeRows: OutcomeRow[] = outcomes.map((o) => {
    const byTicket = o.keys.map((k) => items.get(k)).find((x) => !!x);
    const current = [...items.values()].some((x) => x.id === o.workItemId && x.current);
    const workItem =
      byTicket ?? (o.workItemId ? { id: o.workItemId, name: o.itemName, current } : undefined);
    return {
      kind: "outcome",
      outcome: o,
      reason: o.steps ? `${plural(o.steps, "step")} to approve` : "to read",
      ...(workItem ? { workItem } : {}),
    };
  });
  const outcomeIds = new Set(outcomes.map((o) => o.id));

  // 1. Woken tickets.
  const woken: TicketRow[] = [];
  for (const w of input.woken) {
    const issue = byKey.get(w.key);
    if (!open(issue) || placed.has(w.key)) continue;
    if (cardWoken.has(w.key)) {
      placed.add(w.key);
      continue;
    }
    placed.add(w.key);
    askState.set(w.key, `woke up: ${w.reason}`);
    woken.push({
      kind: "woken",
      issue,
      reason: w.reason,
      at: w.unblockedAt,
      smallAsk: isAsk(issue),
    });
  }

  // 2. Snoozed tickets leave Your move and Sprint work.
  for (const i of input.issues) {
    if (!open(i) || !snoozedNow(i) || placed.has(i.key)) continue;
    placed.add(i.key);
    askState.set(i.key, `snoozed until ${dayMonth(localDateOf(i.snoozedUntil ?? today))}`);
  }

  // 3. Comments and mentions waiting on the user.
  const comments: TicketRow[] = [];
  for (const c of work.waitingOnMe) {
    if (placed.has(c.issue.key)) continue;
    placed.add(c.issue.key);
    if (c.commentId && cardComments.has(c.commentId)) continue;
    askState.set(c.issue.key, `your move: ${c.reasons[0] ?? "new comment"}`);
    comments.push({
      kind: "comment",
      issue: c.issue,
      reason: c.reasons[0] ?? "New comment",
      at: c.at,
      smallAsk: isAsk(c.issue),
      ...(c.commentId ? { commentId: c.commentId } : {}),
    });
  }

  // 4. The user's tickets with an open blocker; snoozed ones sleep last.
  const allBlocked: BlockedRow[] = [];
  const epicKeys = new Set(input.issues.map((i) => i.epicKey).filter((k): k is string => !!k));
  for (const i of input.issues) {
    if (!open(i) || !mine(i) || /epic/i.test(i.issueType) || epicKeys.has(i.key)) continue;
    const { blockedBy } = blockInfo(i.links, input.blockers);
    if (!blockedBy.length) continue;
    const asleep = snoozedNow(i);
    allBlocked.push({
      kind: "blocked",
      issue: i,
      blockedBy,
      asleep,
      reason: asleep
        ? `blocked by ${blockedBy.slice(0, 2).join(", ")}; snoozed until ${dayMonth(localDateOf(i.snoozedUntil ?? today))}`
        : `blocked by ${blockedBy.slice(0, 2).join(", ")}${blockedBy.length > 2 ? ` and ${blockedBy.length - 2} more` : ""}`,
    });
  }
  allBlocked.sort(
    (a, b) => Number(a.asleep) - Number(b.asleep) || a.issue.key.localeCompare(b.issue.key),
  );
  const blocked = allBlocked.filter((b) => b.asleep || !placed.has(b.issue.key));
  for (const b of blocked) {
    placed.add(b.issue.key);
    if (!b.asleep) askState.set(b.issue.key, `blocked by ${b.blockedBy.join(", ")}`);
  }

  // 5. Open small asks with nothing to wait for, by due date, then oldest first.
  const asks: TicketRow[] = [];
  const openAsks: DashIssue[] = [];
  for (const i of input.issues) {
    if (!open(i) || !mine(i) || !isAsk(i)) continue;
    openAsks.push(i);
    if (placed.has(i.key)) continue;
    if (waitedOn.has(i.key)) {
      const w = openWaits.filter((d) => d.issueKey === i.key);
      askState.set(i.key, `waiting on ${w.map((d) => `${d.ownerName} (${d.label})`).join(", ")}`);
      continue;
    }
    placed.add(i.key);
    askState.set(i.key, "your move");
    asks.push({
      kind: "ask",
      issue: i,
      reason: askReason(i, today),
      at: i.created,
      smallAsk: true,
    });
  }
  asks.sort(
    (a, b) =>
      (a.issue.dueDate ?? "9999").localeCompare(b.issue.dueDate ?? "9999") ||
      a.issue.created.localeCompare(b.issue.created) ||
      a.issue.key.localeCompare(b.issue.key),
  );
  // Small asks with an open wait are Their move's; they are not Sprint work either.
  for (const i of input.issues) if (isAsk(i)) placed.add(i.key);

  const threads: ThreadRow[] = input.threads
    .filter((t) => t.proposals + t.questions > 0 && !outcomeIds.has(t.id))
    .map((t) => ({ kind: "thread", thread: t, reason: threadReason(t, today) }));

  // Their move: every open wait, the most pressing first, sleeping ones last.
  const waits: WaitRow[] = openWaits
    .filter((d) => !cardWaits.has(d.id))
    .map((d): WaitRow => {
      const t = timing(d, today);
      const issue = byKey.get(d.issueKey) ?? null;
      const state = waitState(t, snoozedNow(issue));
      return {
        kind: "wait",
        dependency: d,
        timing: t,
        state,
        decided: chaseDecided(t, today),
        reason: waitReason(d, t, state, issue?.snoozedUntil ?? null, today),
        issue,
      };
    })
    .sort(compareWaits);
  const theirMove: TheirMoveRow[] = [
    ...waits.filter((w) => w.state !== "asleep"),
    ...blocked.filter((b) => !b.asleep),
    ...waits.filter((w) => w.state === "asleep"),
    ...blocked.filter((b) => b.asleep),
  ];

  // 6. Sprint work: Top focus of what is left, then due-soon and at-risk tickets.
  const dueSoon = new Map(work.dueSoon.map((i) => [i.key, i.daysLeft]));
  const atRisk = new Map(work.atRisk.map((r) => [r.issue.key, r.reasons]));
  const left = work.ranked.filter((r) => !placed.has(r.key));
  const focusRows = left.filter((r) => work.focusKeys.has(r.key)).slice(0, TOP_FOCUS_LIMIT);
  const inFocus = new Set(focusRows.map((r) => r.key));
  const extras = left
    .filter((r) => !inFocus.has(r.key) && (dueSoon.has(r.key) || atRisk.has(r.key)))
    .slice(0, SPRINT_EXTRA_LIMIT);
  const sprintRow = (issue: FocusItem, focused: boolean): SprintRow => {
    const daysLeft = dueSoon.get(issue.key) ?? null;
    const risks = atRisk.get(issue.key) ?? [];
    const due = issue.dueDate && daysLeft !== null ? dueLabel(issue.dueDate, today) : null;
    return {
      issue,
      inFocus: focused,
      daysLeft,
      risks,
      reason: focused
        ? (issue.contributions[0]?.reason ?? "In the sprint")
        : (risks[0] ?? due ?? "Due soon"),
    };
  };

  const sprints = input.sprints.filter(
    (s): s is SprintInfo =>
      typeof s.id === "number" && s.boardId !== undefined && s.start !== undefined,
  );
  const sprintEnd = userActiveSprints(sprints, input.issues, me)[0]?.end ?? null;

  // Rows name their work item, and the item the user is on comes first (D61).
  const keyOf = (r: YourMoveRow | TheirMoveRow | SprintRow) =>
    "issue" in r && r.issue ? r.issue.key : "dependency" in r ? r.dependency.issueKey : null;
  const named = <R extends YourMoveRow | TheirMoveRow | SprintRow>(rows: R[]): R[] => {
    const out = rows.map((r) => {
      const key = keyOf(r);
      const item = key ? items.get(key) : undefined;
      return item ? { ...r, workItem: item } : r;
    });
    const current = (r: R) => Number(!!(r as { workItem?: WorkItemRef }).workItem?.current);
    return out
      .map((r, i) => ({ r, i }))
      .sort((a, b) => current(b.r) - current(a.r) || a.i - b.i)
      .map((x) => x.r);
  };

  return {
    yourMove: named([...outcomeRows, ...woken, ...asks, ...comments, ...threads]),
    theirMove: named(theirMove),
    sprintWork: named([
      ...focusRows.map((r) => sprintRow(r, true)),
      ...extras.map((r) => sprintRow(r, false)),
    ]),
    focus: work.focus,
    sprintEnd,
    blocked: allBlocked,
    snoozed: work.snoozed,
    inScope: work.inScope,
    smallAsks: {
      home: label !== null,
      open: openAsks
        .sort((a, b) => a.created.localeCompare(b.created) || a.key.localeCompare(b.key))
        .map((issue) => ({ issue, state: askState.get(issue.key) ?? "your move" })),
    },
    facts: {
      topFocus: work.topFocus,
      dueSoon: work.dueSoon.slice(0, FACT_LIMIT),
      atRisk: work.atRisk.slice(0, FACT_LIMIT),
      waitingOnMe: work.waitingOnMe.slice(0, FACT_LIMIT),
    },
  };
}

/**
 * Facts for the chat's suggested prompts (D42), computed in code: what waits
 * on a decision from the user, and what the coming week holds.
 */
import { daysBetween, localDateOf } from "@/lib/dates";

export type PendingProposal = {
  inboxItemId: string;
  threadSummary: string | null;
  receivedAt: string;
  kind: string;
  description: string;
  /** For a question the Inbox asked: the question itself. */
  question: string | null;
  createdAt: string;
};

export type PendingDecisions = {
  inbox: {
    thread: string;
    inboxItemId: string;
    waitingDays: number;
    approve: string[];
    questions: string[];
  }[];
  unsentDrafts: { to: string; about: string[]; days: number }[];
};

/** Proposals and questions waiting in the Inbox, one entry per thread, oldest first. */
export function pendingDecisions(
  proposals: readonly PendingProposal[],
  drafts: readonly { to: string; issueKeys: string[]; updatedAt: string }[],
  today: string,
): PendingDecisions {
  const byThread = new Map<string, PendingDecisions["inbox"][number]>();
  for (const p of [...proposals].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const entry = byThread.get(p.inboxItemId) ?? {
      thread: p.threadSummary ?? "Inbox item",
      inboxItemId: p.inboxItemId,
      waitingDays: Math.max(0, daysBetween(localDateOf(p.createdAt), today)),
      approve: [],
      questions: [],
    };
    if (p.kind === "needs_clarification") entry.questions.push(p.question ?? p.description);
    else entry.approve.push(p.description);
    byThread.set(p.inboxItemId, entry);
  }
  return {
    inbox: [...byThread.values()].sort((a, b) => b.waitingDays - a.waitingDays),
    unsentDrafts: drafts.map((d) => ({
      to: d.to,
      about: d.issueKeys,
      days: Math.max(0, daysBetween(localDateOf(d.updatedAt), today)),
    })),
  };
}

export type WeekInputs = {
  today: string;
  dueSoon: { key: string; summary: string; dueDate: string | null; status: string }[];
  dependencies: {
    issueKey: string;
    label: string;
    owner: string;
    expectedAt: string | null;
    nextFollowupAt: string | null;
  }[];
  sprint: { name: string; end: string | null; total: number; done: number } | null;
  atRisk: { key: string; summary: string; why: string[] }[];
};

const WEEK_DAYS = 7;

/** The next seven days, by day: due tickets, expected answers, follow-ups, sprint end. */
export function weekAhead(w: WeekInputs) {
  const within = (date: string | null) => {
    if (!date) return null;
    const d = daysBetween(w.today, date.slice(0, 10));
    return d <= WEEK_DAYS ? d : null;
  };
  const events: { date: string; daysAway: number; what: string }[] = [];
  for (const i of w.dueSoon) {
    const d = within(i.dueDate);
    if (d !== null && i.dueDate)
      events.push({
        date: i.dueDate,
        daysAway: d,
        what: `${i.key} ${i.summary} due${d < 0 ? ` (${-d} days overdue)` : ""} [${i.status}]`,
      });
  }
  for (const dep of w.dependencies) {
    const expected = within(dep.expectedAt);
    if (expected !== null && dep.expectedAt)
      events.push({
        date: dep.expectedAt,
        daysAway: expected,
        what: `${dep.owner} expected to deliver ${dep.label} for ${dep.issueKey}${expected < 0 ? ` (${-expected} days late)` : ""}`,
      });
    const followup = within(dep.nextFollowupAt);
    if (followup !== null && dep.nextFollowupAt)
      events.push({
        date: dep.nextFollowupAt,
        daysAway: followup,
        what: `Follow up with ${dep.owner} about ${dep.label} (${dep.issueKey})`,
      });
  }
  const sprintEnd = w.sprint ? within(w.sprint.end) : null;
  if (w.sprint?.end && sprintEnd !== null)
    events.push({
      date: w.sprint.end,
      daysAway: sprintEnd,
      what: `Sprint ${w.sprint.name} ends: ${w.sprint.done} of ${w.sprint.total} points done; plan the next sprint in Sprint > Plan`,
    });
  events.sort((a, b) => a.date.localeCompare(b.date) || a.what.localeCompare(b.what));
  return {
    from: w.today,
    days: WEEK_DAYS,
    events,
    atRisk: w.atRisk.slice(0, 5),
    sprint: w.sprint,
  };
}

/** The user's open small asks for `pending_decisions` (D49): who asked, age, due date and where each stands. */
export function smallAskFacts(
  asks: readonly {
    issue: {
      key: string;
      summary: string;
      created: string;
      dueDate: string | null;
      requester: { name: string } | null;
    };
    state: string;
  }[],
  today: string,
) {
  return asks.map(({ issue, state }) => ({
    key: issue.key,
    summary: issue.summary,
    askedBy: issue.requester?.name ?? null,
    // The local date, as Today's "asked 3 days ago" counts it.
    ageDays: Math.max(0, daysBetween(localDateOf(issue.created), today)),
    due: issue.dueDate,
    state,
  }));
}

/** The user's tickets blocked by open tickets, for `waiting_on`. */
export function blockedFacts(
  rows: readonly {
    issue: { key: string; summary: string; status: string };
    blockedBy: string[];
    asleep: boolean;
  }[],
) {
  return rows.map((r) => ({
    key: r.issue.key,
    summary: r.issue.summary,
    status: r.issue.status,
    blockedBy: r.blockedBy,
    ...(r.asleep ? { note: "snoozed" } : {}),
  }));
}

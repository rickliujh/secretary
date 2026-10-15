/**
 * Facts for the dashboard's suggested prompts (D42), computed in code: what
 * waits on a decision from the user, and what the coming week holds.
 */
import { daysBetween } from "@/lib/dates";

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
      waitingDays: Math.max(0, daysBetween(p.createdAt.slice(0, 10), today)),
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
      days: Math.max(0, daysBetween(d.updatedAt.slice(0, 10), today)),
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
      what: `Sprint ${w.sprint.name} ends: ${w.sprint.done} of ${w.sprint.total} points done; plan the next sprint on the Planning page`,
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

/**
 * Order for ticket pickers (drafts): the tickets you are most likely to mean come
 * first, in labelled groups, instead of cache order.
 */
import { Effect } from "effect";
import { localDate } from "@/lib/dates";
import { loadDashboardInputs } from "@/services/dashboard/data";
import { priorityValue } from "@/services/dashboard/scoring";
import { blockInfo, buildDashboard, type DashIssue } from "@/services/dashboard/sections";
import { Settings, settingsOrDefault } from "@/services/settings";

export type PickerTicket = Pick<
  DashIssue,
  | "key"
  | "summary"
  | "status"
  | "statusCategory"
  | "priority"
  | "assignee"
  | "assigneeDisplay"
  | "updated"
  | "lastViewedAt"
> & { blockedBy: string[] };

export type PickerSource = {
  tickets: PickerTicket[];
  /** Top focus keys in rank order (sprint-aware, D29). */
  focus: string[];
};

export type PickerGroup = {
  id: "recipient" | "recent" | "focus" | "blocked" | "open" | "done";
  label: string;
  items: { ticket: PickerTicket; note: string | null }[];
};

/** Who the message is for: their Jira users bring their tickets forward. */
export type PickerRecipient = { label: string; usernames: string[] };

const RECENT_DAYS = 14;
const RECENT_LIMIT = 6;
const RECIPIENT_LIMIT = 10;
const BLOCKED_LIMIT = 10;

const isBlocked = (t: PickerTicket) => t.blockedBy.length > 0 || /block|on hold/i.test(t.status);

const byPriorityThenUpdated = (a: PickerTicket, b: PickerTicket) =>
  priorityValue(b.priority) - priorityValue(a.priority) || b.updated.localeCompare(a.updated);

const blockedNote = (t: PickerTicket) =>
  t.blockedBy.length ? `Blocked by ${t.blockedBy.slice(0, 2).join(", ")}` : t.status;

export function groupForPicker(
  src: PickerSource,
  recipient: PickerRecipient | null,
  now: string,
): PickerGroup[] {
  const byKey = new Map(src.tickets.map((t) => [t.key, t]));
  const used = new Set<string>();
  const groups: PickerGroup[] = [];
  const add = (
    id: PickerGroup["id"],
    label: string,
    list: readonly PickerTicket[],
    note: (t: PickerTicket) => string | null = (t) => (isBlocked(t) ? blockedNote(t) : null),
  ) => {
    const items = list
      .filter((t) => !used.has(t.key))
      .map((ticket) => ({ ticket, note: note(ticket) }));
    for (const i of items) used.add(i.ticket.key);
    if (items.length) groups.push({ id, label, items });
  };
  const open = src.tickets.filter((t) => t.statusCategory !== "done");

  if (recipient?.usernames.length) {
    const users = new Set(recipient.usernames);
    add(
      "recipient",
      `Assigned to ${recipient.label}`,
      open
        .filter((t) => t.assignee && users.has(t.assignee))
        .sort(byPriorityThenUpdated)
        .slice(0, RECIPIENT_LIMIT),
      (t) => (isBlocked(t) ? blockedNote(t) : users.size > 1 ? t.assigneeDisplay : null),
    );
  }

  const since = new Date(Date.parse(now) - RECENT_DAYS * 86_400_000).toISOString();
  add(
    "recent",
    "Recently viewed",
    src.tickets
      .filter((t) => t.lastViewedAt && t.lastViewedAt >= since)
      .sort((a, b) => (b.lastViewedAt ?? "").localeCompare(a.lastViewedAt ?? ""))
      .slice(0, RECENT_LIMIT),
  );

  add(
    "focus",
    "Your focus",
    src.focus.map((k) => byKey.get(k)).filter((t): t is PickerTicket => !!t),
  );

  add(
    "blocked",
    "Blocked",
    open.filter(isBlocked).sort(byPriorityThenUpdated).slice(0, BLOCKED_LIMIT),
    blockedNote,
  );

  add("open", "Other open tickets", [...open].sort(byPriorityThenUpdated));
  add(
    "done",
    "Done",
    src.tickets
      .filter((t) => t.statusCategory === "done")
      .sort((a, b) => b.updated.localeCompare(a.updated)),
    () => null,
  );
  return groups;
}

/** Tickets in sync scope with what the picker ranks on; stale tickets are left out. */
export const loadPickerSource = (now = new Date()) =>
  Effect.gen(function* () {
    const settings = yield* settingsOrDefault(yield* Settings);
    const inputs = yield* loadDashboardInputs(now);
    const dashboard = buildDashboard(inputs, settings.scoring, localDate(now), now.toISOString());
    return {
      tickets: inputs.issues.map((i) => ({
        key: i.key,
        summary: i.summary,
        status: i.status,
        statusCategory: i.statusCategory,
        priority: i.priority,
        assignee: i.assignee,
        assigneeDisplay: i.assigneeDisplay,
        updated: i.updated,
        lastViewedAt: i.lastViewedAt,
        blockedBy: blockInfo(i.links).blockedBy,
      })),
      focus: dashboard.topFocus.map((f) => f.key),
    } satisfies PickerSource;
  });

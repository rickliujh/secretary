/**
 * The derived facts of a work item (D61): its tickets with their Jira fields,
 * open waits with dates, blockers and the people involved, read from the
 * tables the app already holds. They are shown next to the state and sent to
 * the state update, never copied into the state.
 */
import { eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";
import { issueMeta, jiraIssues, people, workItemIssues } from "@/db/schema";
import { localDate } from "@/lib/dates";
import { parseBlockers } from "@/services/blockers/logic";
import { blockInfo } from "@/services/dashboard/sections";
import { query } from "@/services/db";
import { listDependencies } from "@/services/dependencies/queries";
import { parseIssueLinks } from "@/services/jira/schemas";
import { getState, SYNC_KEYS } from "@/services/sync/state";

export type FactTicket = {
  key: string;
  role: "primary" | "related";
  summary: string | null;
  status: string | null;
  statusCategory: string | null;
  assignee: string | null;
  dueDate: string | null;
  sprint: string | null;
  storyPoints: number | null;
  blockedBy: string[];
  /** Not in the cache (an unread blocker): only its key and blocker state are known. */
  unknown: boolean;
};

export type FactWait = {
  id: string;
  issueKey: string;
  label: string;
  owner: string;
  ownerPersonId: string | null;
  status: string;
  requestedAt: string | null;
  expectedAt: string | null;
  nextFollowupAt: string | null;
};

export type ItemFacts = {
  today: string;
  tickets: FactTicket[];
  waits: FactWait[];
  /** Contacts the item involves: wait owners, requesters, assignees, and those its events name. */
  people: { id: string; name: string }[];
};

/** The facts of one item. `contactIds` adds contacts its events name. */
export const loadItemFacts = (
  itemId: string,
  opts: { today?: string; contactIds?: readonly string[] } = {},
) =>
  Effect.gen(function* () {
    const members = yield* query((d) =>
      d
        .select({ key: workItemIssues.issueKey, role: workItemIssues.role })
        .from(workItemIssues)
        .where(eq(workItemIssues.workItemId, itemId))
        .all(),
    );
    const keys = members.map((m) => m.key);
    const rows = keys.length
      ? yield* query((d) =>
          d
            .select({
              key: jiraIssues.key,
              summary: jiraIssues.summary,
              status: jiraIssues.status,
              statusCategory: jiraIssues.statusCategory,
              assignee: jiraIssues.assignee,
              assigneeDisplay: jiraIssues.assigneeDisplay,
              dueDate: jiraIssues.dueDate,
              sprint: jiraIssues.sprint,
              storyPoints: jiraIssues.storyPoints,
              links: sql<string | null>`json_extract(${jiraIssues.raw}, '$.issuelinks')`,
              requester: issueMeta.requesterPersonId,
            })
            .from(jiraIssues)
            .leftJoin(issueMeta, eq(issueMeta.issueKey, jiraIssues.key))
            .where(inArray(jiraIssues.key, keys))
            .all(),
        )
      : [];
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const blockers = parseBlockers(yield* getState(SYNC_KEYS.blockers));
    const tickets = members
      .map((m): FactTicket => {
        const r = byKey.get(m.key);
        const fresh = blockers[m.key];
        return {
          key: m.key,
          role: m.role,
          summary: r?.summary ?? null,
          status: r?.status ?? fresh?.status ?? null,
          statusCategory: r?.statusCategory ?? fresh?.statusCategory ?? null,
          assignee: r ? (r.assigneeDisplay ?? r.assignee ?? null) : null,
          dueDate: r?.dueDate ?? null,
          sprint: r?.sprint ?? null,
          storyPoints: r?.storyPoints ?? null,
          blockedBy: r ? blockInfo(parseIssueLinks(r.links), blockers).blockedBy : [],
          unknown: !r,
        };
      })
      .sort((a, b) => Number(a.role === "related") - Number(b.role === "related"));
    const deps = keys.length ? yield* listDependencies() : [];
    const waits = deps
      .filter((x) => keys.includes(x.issueKey))
      .map(
        (x): FactWait => ({
          id: x.id,
          issueKey: x.issueKey,
          label: x.label,
          owner: x.owner.name,
          ownerPersonId: x.ownerPersonId,
          status: x.status,
          requestedAt: x.requestedAt,
          expectedAt: x.expectedAt,
          nextFollowupAt: x.nextFollowupAt,
        }),
      );
    const assignees = rows.map((r) => r.assignee).filter((a): a is string => !!a);
    const wanted = new Set([
      ...waits.map((w) => w.ownerPersonId).filter((x): x is string => !!x),
      ...rows.map((r) => r.requester).filter((x): x is string => !!x),
      ...(opts.contactIds ?? []),
    ]);
    const contacts = yield* query((d) =>
      d
        .select({ id: people.id, name: people.displayName, jira: people.jiraUsername })
        .from(people)
        .all(),
    );
    const lower = new Set(assignees.map((a) => a.toLowerCase()));
    const involved = contacts
      .filter((c) => wanted.has(c.id) || (!!c.jira && lower.has(c.jira.toLowerCase())))
      .map((c) => ({ id: c.id, name: c.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      today: opts.today ?? localDate(),
      tickets,
      waits,
      people: involved,
    } satisfies ItemFacts;
  });

/** Every date the facts hold: due dates, waits' dates, today. */
export function factDates(f: ItemFacts): string[] {
  return [
    f.today,
    ...f.tickets.map((t) => t.dueDate),
    ...f.waits.flatMap((w) => [w.expectedAt, w.nextFollowupAt, w.requestedAt?.slice(0, 10)]),
  ].filter((d): d is string => !!d);
}

/** The facts as text: what a person reading the item would want next to the state. */
export function renderFacts(f: ItemFacts): string {
  const ticket = (t: FactTicket) => {
    if (t.unknown) return `- ${t.key} (${t.role})${t.status ? `: ${t.status}` : ""}`;
    const parts = [
      t.status,
      t.assignee ? `assignee ${t.assignee}` : "unassigned",
      t.dueDate && `due ${t.dueDate}`,
      t.sprint && `sprint ${t.sprint}`,
      t.storyPoints !== null && `${t.storyPoints} points`,
      t.blockedBy.length && `blocked by ${t.blockedBy.join(", ")}`,
    ].filter(Boolean);
    return `- ${t.key} (${t.role}) "${t.summary ?? ""}": ${parts.join(", ")}`;
  };
  const wait = (w: FactWait) =>
    `- On ${w.owner}${w.ownerPersonId ? ` (contact ${w.ownerPersonId})` : ""} for "${w.label}" on ${w.issueKey}: ${[
      w.status,
      w.requestedAt && `since ${w.requestedAt.slice(0, 10)}`,
      w.expectedAt && `expected ${w.expectedAt}`,
      w.nextFollowupAt && `next chase ${w.nextFollowupAt}`,
    ]
      .filter(Boolean)
      .join(", ")}`;
  return [
    `Today: ${f.today}`,
    "Tickets:",
    ...(f.tickets.length ? f.tickets.map(ticket) : ["- none"]),
    "Open waits:",
    ...(f.waits.length ? f.waits.map(wait) : ["- none"]),
  ].join("\n");
}

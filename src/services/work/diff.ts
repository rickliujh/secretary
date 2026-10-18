/**
 * What changed on a ticket between the cached row and the one Jira just
 * returned (D61): sync records each change as an event before writing the new
 * row. Pure. Reading Jira's changelog is not needed for this: the cache already
 * holds the last row the app saw.
 */
import { blockLinks } from "@/services/dashboard/sections";
import { type IssueLink, parseIssueLinks } from "@/services/jira/schemas";
import { EVENT_TEXT_CHARS, type NewEvent } from "./events";
import type { Actor } from "./schema";

/** The columns a change event is about. */
export type DiffRow = {
  key: string;
  summary: string;
  status: string;
  assignee: string | null;
  assigneeDisplay: string | null;
  dueDate: string | null;
  sprint: string | null;
  storyPoints: number | null;
  resolved: string | null;
  /** `issuelinks` as stored (raw JSON) or parsed. */
  links: unknown;
  updated: string;
};

export type FieldChange = {
  field:
    | "status"
    | "assignee"
    | "dueDate"
    | "sprint"
    | "storyPoints"
    | "summary"
    | "links"
    | "resolution";
  from: string | null;
  to: string | null;
  summary: string;
};

/** "is blocked by PLAT-812", "relates to PAY-9": each link of an issue as a phrase. */
export function linkPhrases(links: unknown): string[] {
  const parsed: IssueLink[] = parseIssueLinks(links);
  const out = new Set<string>();
  for (const b of blockLinks(parsed))
    out.add(`${b.direction === "blockedBy" ? "is blocked by" : "blocks"} ${b.key}`);
  for (const l of parsed) {
    if (/block/i.test(`${l.type.name} ${l.type.inward}`)) continue;
    const other = l.outwardIssue ?? l.inwardIssue;
    const verb = l.outwardIssue ? l.type.outward : l.type.inward;
    if (other) out.add(`${verb} ${other.key}`);
  }
  return [...out].sort();
}

const text = (v: string | number | null | undefined) =>
  v === null || v === undefined || v === "" ? null : String(v);

/** Each field that changed, in a fixed order. */
export function issueChanges(before: DiffRow, after: DiffRow): FieldChange[] {
  const key = after.key;
  const out: FieldChange[] = [];
  if (before.status !== after.status)
    out.push({
      field: "status",
      from: before.status,
      to: after.status,
      summary: `${key} moved from ${before.status} to ${after.status}`,
    });
  if ((before.assignee ?? null) !== (after.assignee ?? null))
    out.push({
      field: "assignee",
      from: text(before.assigneeDisplay ?? before.assignee),
      to: text(after.assigneeDisplay ?? after.assignee),
      summary: after.assignee
        ? `${key} assigned to ${after.assigneeDisplay ?? after.assignee}`
        : `${key} unassigned`,
    });
  if ((before.dueDate ?? null) !== (after.dueDate ?? null))
    out.push({
      field: "dueDate",
      from: text(before.dueDate),
      to: text(after.dueDate),
      summary: after.dueDate
        ? `${key} due date ${before.dueDate ? `moved from ${before.dueDate} to` : "set to"} ${after.dueDate}`
        : `${key} due date cleared`,
    });
  if ((before.sprint ?? null) !== (after.sprint ?? null))
    out.push({
      field: "sprint",
      from: text(before.sprint),
      to: text(after.sprint),
      summary: after.sprint ? `${key} now in ${after.sprint}` : `${key} moved to the backlog`,
    });
  if ((before.storyPoints ?? null) !== (after.storyPoints ?? null))
    out.push({
      field: "storyPoints",
      from: text(before.storyPoints),
      to: text(after.storyPoints),
      summary:
        after.storyPoints === null
          ? `${key} points cleared`
          : `${key} points ${before.storyPoints === null ? "set to" : `changed from ${before.storyPoints} to`} ${after.storyPoints}`,
    });
  if (before.summary !== after.summary)
    out.push({
      field: "summary",
      from: before.summary,
      to: after.summary,
      summary: `${key} renamed to "${after.summary}"`,
    });
  if (!!before.resolved !== !!after.resolved)
    out.push({
      field: "resolution",
      from: text(before.resolved),
      to: text(after.resolved),
      summary: after.resolved ? `${key} resolved` : `${key} reopened`,
    });
  const was = new Set(linkPhrases(before.links));
  const now = new Set(linkPhrases(after.links));
  for (const p of now)
    if (!was.has(p)) out.push({ field: "links", from: null, to: p, summary: `${key} now ${p}` });
  for (const p of was)
    if (!now.has(p))
      out.push({ field: "links", from: p, to: null, summary: `${key} no longer ${p}` });
  return out;
}

/**
 * Events for a page of upserted issues: one per changed field of an issue the
 * cache held. A ticket seen for the first time records nothing: it is new to
 * the app, not a change.
 */
export function issueChangeEvents(
  before: ReadonlyMap<string, DiffRow>,
  after: readonly DiffRow[],
  origin: { kind: "jira_change" | "ticket_edited"; actor: Actor },
): NewEvent[] {
  return after.flatMap((row) => {
    const prev = before.get(row.key);
    if (!prev) return [];
    return issueChanges(prev, row).map(
      (c): NewEvent => ({
        kind: origin.kind,
        at: origin.kind === "jira_change" ? row.updated : undefined,
        actor: origin.actor,
        issueKey: row.key,
        summary: c.summary,
        data: { field: c.field, from: c.from, to: c.to },
      }),
    );
  });
}

export type CommentLike = {
  id: string;
  issueKey: string;
  author: string | null;
  authorDisplay: string | null;
  body: string;
  created: string;
};

/** A comment the cache did not hold, on an issue it did, is an event (by its author). */
export function newCommentEvents(
  known: ReadonlySet<string>,
  cachedIssues: ReadonlySet<string>,
  comments: readonly CommentLike[],
  actorOf: (author: string | null) => Actor,
  kind: "jira_comment" | "ticket_edited" = "jira_comment",
): NewEvent[] {
  return comments
    .filter((c) => cachedIssues.has(c.issueKey) && !known.has(c.id))
    .map(
      (c): NewEvent => ({
        kind,
        at: c.created,
        actor: actorOf(c.author),
        issueKey: c.issueKey,
        ref: c.id,
        summary: `${c.authorDisplay ?? c.author ?? "Someone"} commented on ${c.issueKey}`,
        data: { field: "comment", text: c.body.slice(0, EVENT_TEXT_CHARS) },
      }),
    );
}

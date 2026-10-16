/**
 * Edit-form field specs per proposal kind. Values are flattened to strings by
 * path for react-hook-form and rebuilt into a payload that is re-validated.
 */

import type { Lookups } from "@/app/queries";
import { CHANNELS, DETAIL, FORMALITY, RESPONSIVENESS } from "@/services/directory/schema";
import {
  DEPENDENCY_KINDS,
  ISSUE_TYPES,
  MEMORY_KINDS,
  MESSAGE_INTENTS,
  type ProposalKind,
  type ProposalPayload,
  WAIT_ACTIONS,
} from "@/services/proposals/schema";

/** Which tickets an issue field offers: epics, possible sub-task parents, or any. */
export type IssueFilter = "epic" | "parent" | "any";

export type FieldSpec = {
  path: string;
  label: string;
  /** `clear`: a checkbox that sets the field at `path` to null when ticked. */
  type: "text" | "textarea" | "date" | "number" | "select" | "list" | "issue" | "clear";
  /** For `issue` fields. */
  issues?: IssueFilter;
  options?: (l: Lookups) => { value: string; label: string }[];
  mono?: boolean;
  /** Inside `changes`: empty means "do not change" rather than "clear". */
  optionalChange?: boolean;
  /** Empty leaves the field out rather than setting it to null (a new contact's profile, D60). */
  omitEmpty?: boolean;
  /** Left out of the form while the other values make it meaningless. */
  hidden?: (values: Readonly<Record<string, string>>) => boolean;
};

/** An Epic by type name; it never gets story points (D55). */
const isEpicType = (type: unknown) => typeof type === "string" && /^epic$/i.test(type.trim());

/** The form value name of a field; a `clear` checkbox shares its field's path. */
export const formName = (spec: Pick<FieldSpec, "path" | "type">) =>
  fieldName(spec.path) + (spec.type === "clear" ? "__clear" : "");

const opts = (values: readonly string[]) => () =>
  values.map((v) => ({ value: v, label: v.replace(/_/g, " ") }));
/** Contacts, then the thread's new ones by ref (D60). */
const peopleOpts = (l: Lookups) => [
  ...l.people.map((p) => ({ value: p.id, label: p.displayName })),
  ...(l.refs?.people ?? []).map((r) => ({ value: r.ref, label: `${r.name} (new)` })),
];
/** Teams, then the thread's new ones by ref (D60). */
const teamOpts = (l: Lookups) => [
  ...l.teams.map((t) => ({ value: t.id, label: t.name })),
  ...(l.refs?.teams ?? []).map((r) => ({ value: r.ref, label: `${r.name} (new)` })),
];
/**
 * The communication profile's fields: a change of an existing contact's
 * (`optionalChange`), or a new contact's, whose empty ones are left out (D60).
 */
const profileFields = (prefix: string, change: boolean): FieldSpec[] => {
  const empty = change ? { optionalChange: true } : { omitEmpty: true };
  return [
    {
      path: `${prefix}formality`,
      label: "Formality",
      type: "select",
      options: opts(FORMALITY),
      ...empty,
    },
    { path: `${prefix}detail`, label: "Detail", type: "select", options: opts(DETAIL), ...empty },
    {
      path: `${prefix}responsiveness`,
      label: "Responsiveness",
      type: "select",
      options: opts(RESPONSIVENESS),
      ...empty,
    },
    {
      path: `${prefix}preferredChannel`,
      label: "Channel",
      type: "select",
      options: opts(CHANNELS),
      ...empty,
    },
    { path: `${prefix}tone`, label: "Tone", type: "text", ...empty },
  ];
};
const projectOpts = (l: Lookups) =>
  [...new Set(l.tickets.map((t) => t.projectKey))].sort().map((k) => ({ value: k, label: k }));

const target: FieldSpec = { path: "target", label: "Issue", type: "issue", issues: "any" };

type PickerTicket = Pick<
  Lookups["tickets"][number],
  | "key"
  | "summary"
  | "issueType"
  | "isSubtask"
  | "projectKey"
  | "epicKey"
  | "statusCategory"
  | "stale"
>;

/**
 * Tickets an issue field offers, as options: epics (by type, or anything with
 * children, since some projects name the type differently), possible sub-task
 * parents, or any ticket. Open ones first, the given project's first, then by key.
 */
export function issueOptions(
  tickets: readonly PickerTicket[],
  filter: IssueFilter,
  project?: string,
): { value: string; label: string; hint: string }[] {
  const parents = new Set(tickets.map((t) => t.epicKey).filter((k): k is string => !!k));
  const isEpic = (t: PickerTicket) => /epic/i.test(t.issueType) || parents.has(t.key);
  const keep = (t: PickerTicket) =>
    !t.stale &&
    (filter === "epic" ? isEpic(t) : filter === "parent" ? !isEpic(t) && !t.isSubtask : true);
  const rank = (t: PickerTicket) =>
    (t.statusCategory === "done" ? 2 : 0) + (project && t.projectKey !== project ? 1 : 0);
  return tickets
    .filter(keep)
    .sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key, undefined, { numeric: true }))
    .map((t) => ({
      value: t.key,
      label: t.summary,
      hint: t.statusCategory === "done" ? `${t.issueType}, done` : t.issueType,
    }));
}

/**
 * Kinds without an edit form: a question is answered, not edited, and a sprint
 * move is built by the planner from stored sprint ids (D30), so it is approved or
 * rejected as it is.
 */
type EditableKind = Exclude<ProposalKind, "needs_clarification" | "move_to_sprint">;
type EditablePayload = Extract<ProposalPayload, { kind: EditableKind }>;

export const FIELD_SPECS: Record<EditableKind, FieldSpec[]> = {
  create_issue: [
    { path: "projectKey", label: "Project", type: "select", options: projectOpts },
    { path: "issueType", label: "Type", type: "select", options: opts(ISSUE_TYPES) },
    { path: "summary", label: "Summary", type: "text" },
    { path: "descriptionMd", label: "Description (Markdown)", type: "textarea" },
    { path: "epic", label: "Epic", type: "issue", issues: "epic" },
    { path: "parent", label: "Parent (sub-tasks)", type: "issue", issues: "parent" },
    { path: "priority", label: "Priority", type: "text" },
    { path: "assignee", label: "Assignee (Jira user)", type: "text", mono: true },
    { path: "dueDate", label: "Due", type: "date" },
    {
      path: "storyPoints",
      label: "Story points",
      type: "number",
      hidden: (v) => isEpicType(v.issueType),
    },
    { path: "labels", label: "Labels (comma separated)", type: "list", mono: true },
    { path: "requesterPersonId", label: "Asked by", type: "select", options: peopleOpts },
  ],
  update_issue: [
    target,
    { path: "changes.summary", label: "Summary", type: "text", optionalChange: true },
    { path: "changes.priority", label: "Priority", type: "text", optionalChange: true },
    { path: "changes.dueDate", label: "Due", type: "date", optionalChange: true },
    {
      path: "changes.assignee",
      label: "Assignee (Jira user)",
      type: "text",
      mono: true,
      optionalChange: true,
    },
    {
      path: "changes.storyPoints",
      label: "Story points",
      type: "number",
      optionalChange: true,
      hidden: (v) => v.changes__storyPoints__clear === "true",
    },
    // FR-15.3: an empty points field means "no change", so clearing is explicit.
    { path: "changes.storyPoints", label: "Clear story points on the ticket", type: "clear" },
  ],
  add_comment: [target, { path: "bodyMd", label: "Comment (Markdown)", type: "textarea" }],
  transition_issue: [target, { path: "toStatus", label: "Move to status", type: "text" }],
  link_dependency: [
    target,
    {
      path: "dependencyKind",
      label: "Waiting on",
      type: "select",
      options: opts(DEPENDENCY_KINDS),
    },
    { path: "label", label: "Label", type: "text" },
    { path: "ownerPersonId", label: "Owner (person)", type: "select", options: peopleOpts },
    { path: "ownerTeamId", label: "Owner (team)", type: "select", options: teamOpts },
    { path: "externalRef", label: "Reference (e.g. INC number)", type: "text", mono: true },
    { path: "externalUrl", label: "URL", type: "text" },
    { path: "expectedAt", label: "Expected", type: "date" },
    { path: "nextFollowupAt", label: "Next follow-up", type: "date" },
  ],
  update_dependency: [
    { path: "action", label: "Do", type: "select", options: opts(WAIT_ACTIONS) },
    { path: "summary", label: "What they said", type: "textarea" },
    { path: "expectedAt", label: "Expected", type: "date" },
    { path: "nextFollowupAt", label: "Ask again on", type: "date" },
  ],
  link_issues: [
    { path: "target", label: "Waits (is blocked)", type: "issue", issues: "any" },
    { path: "blocker", label: "Until this is done", type: "issue", issues: "any" },
  ],
  update_person: [
    { path: "personId", label: "Contact", type: "select", options: peopleOpts },
    { path: "changes.awayUntil", label: "Away until", type: "date", optionalChange: true },
    { path: "changes.title", label: "Title", type: "text", optionalChange: true },
    {
      path: "changes.responsibilities",
      label: "Responsibilities",
      type: "textarea",
      optionalChange: true,
    },
    {
      path: "changes.team",
      label: "Move to team",
      type: "select",
      options: teamOpts,
      optionalChange: true,
      hidden: (v) => v.changes__team__clear === "true",
    },
    // An empty team means "no change", so taking them out of their team is explicit (D60).
    { path: "changes.team", label: "Take them out of their team", type: "clear" },
    ...profileFields("changes.profile.", true),
    { path: "noteAppend", label: "Add to notes", type: "textarea" },
  ],
  update_team: [
    { path: "teamId", label: "Team", type: "select", options: teamOpts },
    { path: "changes.function", label: "Function", type: "text", optionalChange: true },
    { path: "changes.contactFor", label: "Contact for", type: "textarea", optionalChange: true },
    { path: "changes.channel", label: "Channel", type: "text", optionalChange: true },
    {
      path: "changes.escalationPath",
      label: "Escalation path",
      type: "textarea",
      optionalChange: true,
    },
    { path: "noteAppend", label: "Add to notes", type: "textarea" },
  ],
  create_team: [
    { path: "name", label: "Name", type: "text" },
    { path: "function", label: "Function", type: "text" },
    { path: "contactFor", label: "Contact for", type: "textarea" },
    { path: "channel", label: "Channel", type: "text" },
    { path: "escalationPath", label: "Escalation path", type: "textarea" },
    { path: "note", label: "Note", type: "textarea" },
  ],
  create_person: [
    { path: "displayName", label: "Name", type: "text" },
    { path: "title", label: "Title", type: "text" },
    { path: "team", label: "Team", type: "select", options: teamOpts },
    { path: "email", label: "Email", type: "text" },
    { path: "jiraUsername", label: "Jira user", type: "text", mono: true },
    { path: "responsibilities", label: "Responsibilities", type: "textarea" },
    ...profileFields("profile.", false),
    { path: "note", label: "Note", type: "textarea" },
  ],
  remember: [
    { path: "memoryKind", label: "Kind", type: "select", options: opts(MEMORY_KINDS) },
    { path: "content", label: "What to remember", type: "textarea" },
  ],
  draft_message: [
    { path: "channel", label: "Channel", type: "select", options: opts(["teams", "email"]) },
    { path: "intent", label: "Intent", type: "select", options: opts(MESSAGE_INTENTS) },
    { path: "recipientPersonId", label: "To (person)", type: "select", options: peopleOpts },
    { path: "recipientTeamId", label: "To (team)", type: "select", options: teamOpts },
    { path: "issueKeys", label: "Issues (comma separated)", type: "list", mono: true },
    { path: "notes", label: "What to say", type: "textarea" },
  ],
};

const get = (o: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined),
      o,
    );

function set(o: Record<string, unknown>, path: string, value: unknown) {
  const keys = path.split(".");
  let cur = o;
  for (const k of keys.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  const last = keys.at(-1) ?? "";
  if (value === undefined) delete cur[last];
  else cur[last] = value;
}

export const isEditable = (p: ProposalPayload): p is EditablePayload => p.kind in FIELD_SPECS;

/** Field names cannot contain dots in react-hook-form's flat mode, so encode them. */
export const fieldName = (path: string) => path.replace(/\./g, "__");

export function toFormValues(payload: ProposalPayload): Record<string, string> {
  if (!isEditable(payload)) return {};
  const out: Record<string, string> = {};
  for (const spec of FIELD_SPECS[payload.kind]) {
    const v = get(payload, spec.path);
    out[formName(spec)] =
      spec.type === "clear"
        ? v === null
          ? "true"
          : ""
        : Array.isArray(v)
          ? v.join(", ")
          : v === null || v === undefined
            ? ""
            : String(v);
  }
  return out;
}

/**
 * A create's points after the user edited it (D55), also used by the small-ask
 * row: an Epic gets none; points the user set or changed are theirs, no longer a
 * suggestion; points the user emptied stay cleared on a revision.
 */
export function editedPoints(
  original: {
    storyPoints?: number | null;
    storyPointsEstimated?: boolean;
    storyPointsCleared?: boolean;
  },
  edited: { issueType?: unknown; storyPoints?: unknown },
): { storyPoints: unknown; storyPointsEstimated: boolean; storyPointsCleared: boolean } {
  const before = original.storyPoints ?? null;
  const after = isEpicType(edited.issueType) ? null : (edited.storyPoints ?? null);
  if (after === before)
    return {
      storyPoints: after,
      storyPointsEstimated: original.storyPointsEstimated ?? false,
      storyPointsCleared: original.storyPointsCleared ?? false,
    };
  return {
    storyPoints: after,
    storyPointsEstimated: false,
    // Changing the type to Epic is not the user clearing the points.
    storyPointsCleared: after === null && !isEpicType(edited.issueType),
  };
}

/** Rebuilds a payload from form values on top of the original (unlisted fields are kept). */
export function fromFormValues(original: ProposalPayload, values: Record<string, string>): unknown {
  if (!isEditable(original)) return original;
  const out = structuredClone(original) as Record<string, unknown>;
  for (const spec of FIELD_SPECS[original.kind]) {
    const raw = (values[formName(spec)] ?? "").trim();
    // A ticked clear box wins over its field, listed before it.
    if (spec.type === "clear") {
      if (raw === "true") set(out, spec.path, null);
      continue;
    }
    let value: unknown;
    if (spec.type === "list") value = raw ? raw.split(/[\s,]+/).filter(Boolean) : [];
    else if (raw === "") value = spec.optionalChange || spec.omitEmpty ? undefined : null;
    // Not a number: kept as text, so validation names the field.
    else if (spec.type === "number") value = Number.isFinite(Number(raw)) ? Number(raw) : raw;
    else value = raw;
    set(out, spec.path, value);
  }
  if (original.kind === "create_issue") Object.assign(out, editedPoints(original, out));
  // An emptied profile object means "no profile change".
  const changes = out.changes as Record<string, unknown> | undefined;
  if (changes?.profile && Object.keys(changes.profile as object).length === 0)
    delete changes.profile;
  return out;
}

/**
 * A payload as the card shows it. `parsePayload` returns a stored payload that no
 * longer parses as it was stored, so fields added later (labels) or required
 * nested objects may be missing; they read as empty here instead of crashing.
 */
export function viewPayload(p: ProposalPayload): ProposalPayload {
  const v = p as Record<string, unknown>;
  const arr = (x: unknown) =>
    Array.isArray(x) ? x.filter((y): y is string => typeof y === "string") : [];
  const obj = (x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? x : {});
  switch (p.kind) {
    case "create_issue":
      return {
        ...p,
        labels: arr(v.labels),
        storyPoints: typeof v.storyPoints === "number" ? v.storyPoints : null,
        storyPointsEstimated: v.storyPointsEstimated === true,
        storyPointsCleared: v.storyPointsCleared === true,
      };
    case "draft_message":
      return { ...p, issueKeys: arr(v.issueKeys) };
    case "update_issue":
    case "update_person":
    case "update_team":
      return { ...p, changes: obj(v.changes) } as ProposalPayload;
    case "create_person":
      return { ...p, profile: obj(v.profile) } as ProposalPayload;
    default:
      return p;
  }
}

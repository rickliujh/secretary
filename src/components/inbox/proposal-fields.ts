/**
 * Edit-form field specs per proposal kind. Values are flattened to strings by
 * path for react-hook-form and rebuilt into a payload that is re-validated.
 */
import { CHANNELS, DETAIL, FORMALITY, RESPONSIVENESS } from "@/services/directory/schema";
import {
  DEPENDENCY_KINDS,
  ISSUE_TYPES,
  MEMORY_KINDS,
  MESSAGE_INTENTS,
  type ProposalKind,
  type ProposalPayload,
} from "@/services/proposals/schema";
import type { Lookups } from "./use-inbox";

export type FieldSpec = {
  path: string;
  label: string;
  type: "text" | "textarea" | "date" | "select" | "list";
  options?: (l: Lookups) => { value: string; label: string }[];
  mono?: boolean;
  /** Inside `changes`: empty means "do not change" rather than "clear". */
  optionalChange?: boolean;
};

const opts = (values: readonly string[]) => () =>
  values.map((v) => ({ value: v, label: v.replace(/_/g, " ") }));
const peopleOpts = (l: Lookups) => l.people.map((p) => ({ value: p.id, label: p.displayName }));
const teamOpts = (l: Lookups) => l.teams.map((t) => ({ value: t.id, label: t.name }));
const projectOpts = (l: Lookups) =>
  [...new Set(l.tickets.map((t) => t.projectKey))].sort().map((k) => ({ value: k, label: k }));

const target: FieldSpec = { path: "target", label: "Issue", type: "text", mono: true };

export const FIELD_SPECS: Record<Exclude<ProposalKind, "needs_clarification">, FieldSpec[]> = {
  create_issue: [
    { path: "projectKey", label: "Project", type: "select", options: projectOpts },
    { path: "issueType", label: "Type", type: "select", options: opts(ISSUE_TYPES) },
    { path: "summary", label: "Summary", type: "text" },
    { path: "descriptionMd", label: "Description (Markdown)", type: "textarea" },
    { path: "epic", label: "Epic", type: "text", mono: true },
    { path: "parent", label: "Parent (sub-tasks)", type: "text", mono: true },
    { path: "priority", label: "Priority", type: "text" },
    { path: "assignee", label: "Assignee (Jira user)", type: "text", mono: true },
    { path: "dueDate", label: "Due", type: "date" },
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
  update_person: [
    { path: "personId", label: "Contact", type: "select", options: peopleOpts },
    { path: "changes.title", label: "Title", type: "text", optionalChange: true },
    {
      path: "changes.responsibilities",
      label: "Responsibilities",
      type: "textarea",
      optionalChange: true,
    },
    {
      path: "changes.profile.formality",
      label: "Formality",
      type: "select",
      options: opts(FORMALITY),
      optionalChange: true,
    },
    {
      path: "changes.profile.detail",
      label: "Detail",
      type: "select",
      options: opts(DETAIL),
      optionalChange: true,
    },
    {
      path: "changes.profile.responsiveness",
      label: "Responsiveness",
      type: "select",
      options: opts(RESPONSIVENESS),
      optionalChange: true,
    },
    {
      path: "changes.profile.preferredChannel",
      label: "Channel",
      type: "select",
      options: opts(CHANNELS),
      optionalChange: true,
    },
    { path: "changes.profile.tone", label: "Tone", type: "text", optionalChange: true },
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

/** Field names cannot contain dots in react-hook-form's flat mode, so encode them. */
export const fieldName = (path: string) => path.replace(/\./g, "__");

export function toFormValues(payload: ProposalPayload): Record<string, string> {
  if (payload.kind === "needs_clarification") return {};
  const out: Record<string, string> = {};
  for (const spec of FIELD_SPECS[payload.kind]) {
    const v = get(payload, spec.path);
    out[fieldName(spec.path)] = Array.isArray(v)
      ? v.join(", ")
      : v === null || v === undefined
        ? ""
        : String(v);
  }
  return out;
}

/** Rebuilds a payload from form values on top of the original (unlisted fields are kept). */
export function fromFormValues(original: ProposalPayload, values: Record<string, string>): unknown {
  if (original.kind === "needs_clarification") return original;
  const out = structuredClone(original) as Record<string, unknown>;
  for (const spec of FIELD_SPECS[original.kind]) {
    const raw = (values[fieldName(spec.path)] ?? "").trim();
    let value: unknown;
    if (spec.type === "list") value = raw ? raw.split(/[\s,]+/).filter(Boolean) : [];
    else if (raw === "") value = spec.optionalChange ? undefined : null;
    else value = raw;
    set(out, spec.path, value);
  }
  // An emptied profile object means "no profile change".
  const changes = out.changes as Record<string, unknown> | undefined;
  if (changes?.profile && Object.keys(changes.profile as object).length === 0)
    delete changes.profile;
  return out;
}

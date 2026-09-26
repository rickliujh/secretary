/**
 * Canonical proposal payloads (FR-2.2), as stored in `proposals.payload` and
 * edited in the UI. Model output is mapped to these in code; the Executor runs
 * them. `$new:n` refers to an issue created earlier in the same inbox item.
 */
import { z } from "zod";
import { ProfileSchema, SUBJECT_TYPES } from "@/services/directory/schema";

export const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
export const NEW_REF_RE = /^\$new:\d+$/;

export const IssueKey = z.string().regex(ISSUE_KEY_RE, "Invalid issue key");
export const NewRef = z.string().regex(NEW_REF_RE, "Invalid $new reference");
export const IssueRef = z.union([IssueKey, NewRef]);
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const IsoDate = z.string().regex(ISO_DATE_RE, "Use YYYY-MM-DD");

export const ISSUE_TYPES = ["Epic", "Story", "Task", "Sub-task", "Bug"] as const;
export const DEPENDENCY_KINDS = ["person", "team", "incident", "external"] as const;
export const MEMORY_KINDS = ["rule", "fact", "preference"] as const;
export const MESSAGE_INTENTS = [
  "chase",
  "status_update",
  "request",
  "escalation",
  "fyi",
  "thank_you",
] as const;

export const CreateIssue = z.object({
  kind: z.literal("create_issue"),
  ref: NewRef,
  projectKey: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
  issueType: z.string().min(1),
  summary: z.string().trim().min(1).max(255),
  descriptionMd: z.string().nullable().default(null),
  parent: IssueRef.nullable().default(null),
  epic: IssueRef.nullable().default(null),
  priority: z.string().nullable().default(null),
  assignee: z.string().nullable().default(null),
  dueDate: IsoDate.nullable().default(null),
});

export const UpdateIssue = z.object({
  kind: z.literal("update_issue"),
  target: IssueRef,
  changes: z
    .object({
      summary: z.string().trim().min(1).max(255).optional(),
      priority: z.string().min(1).optional(),
      dueDate: IsoDate.nullable().optional(),
      assignee: z.string().min(1).nullable().optional(),
    })
    .refine((c) => Object.keys(c).length > 0, "Nothing to update"),
});

export const AddComment = z.object({
  kind: z.literal("add_comment"),
  target: IssueRef,
  bodyMd: z.string().trim().min(1),
});

export const TransitionIssue = z.object({
  kind: z.literal("transition_issue"),
  target: IssueRef,
  toStatus: z.string().trim().min(1),
});

/**
 * Moves an existing issue into a sprint through the Agile API (D30). Built by
 * the sprint planner from ids the sync stored, never proposed by intake.
 */
export const MoveToSprint = z.object({
  kind: z.literal("move_to_sprint"),
  target: IssueKey,
  sprintId: z.number().int().positive(),
  sprintName: z.string().trim().min(1),
});

export const LinkDependency = z.object({
  kind: z.literal("link_dependency"),
  target: IssueRef,
  dependencyKind: z.enum(DEPENDENCY_KINDS),
  label: z.string().trim().min(1).max(300),
  ownerPersonId: z.string().nullable().default(null),
  ownerTeamId: z.string().nullable().default(null),
  externalRef: z.string().nullable().default(null),
  externalUrl: z.string().nullable().default(null),
  expectedAt: IsoDate.nullable().default(null),
  nextFollowupAt: IsoDate.nullable().default(null),
});

export const UpdatePerson = z.object({
  kind: z.literal("update_person"),
  personId: z.string().min(1),
  changes: z
    .object({
      title: z.string().trim().min(1).max(200).optional(),
      responsibilities: z.string().trim().min(1).max(2000).optional(),
      profile: ProfileSchema.optional(),
    })
    .default({}),
  noteAppend: z.string().trim().min(1).nullable().default(null),
});

export const UpdateTeam = z.object({
  kind: z.literal("update_team"),
  teamId: z.string().min(1),
  changes: z
    .object({
      function: z.string().trim().min(1).max(500).optional(),
      contactFor: z.string().trim().min(1).max(1000).optional(),
      channel: z.string().trim().min(1).max(200).optional(),
      escalationPath: z.string().trim().min(1).max(1000).optional(),
    })
    .default({}),
  noteAppend: z.string().trim().min(1).nullable().default(null),
});

export const Remember = z.object({
  kind: z.literal("remember"),
  memoryKind: z.enum(MEMORY_KINDS),
  content: z.string().trim().min(1).max(2000),
  subjectType: z.enum(SUBJECT_TYPES).nullable().default(null),
  subjectId: z.string().nullable().default(null),
});

export const DraftMessage = z.object({
  kind: z.literal("draft_message"),
  channel: z.enum(["teams", "email"]),
  intent: z.enum(MESSAGE_INTENTS),
  recipientPersonId: z.string().nullable().default(null),
  recipientTeamId: z.string().nullable().default(null),
  issueKeys: z.array(IssueRef).default([]),
  notes: z.string().default(""),
});

export const NeedsClarification = z.object({
  kind: z.literal("needs_clarification"),
  question: z.string().trim().min(1),
});

export const ProposalPayloadSchema = z.discriminatedUnion("kind", [
  CreateIssue,
  UpdateIssue,
  AddComment,
  TransitionIssue,
  MoveToSprint,
  LinkDependency,
  UpdatePerson,
  UpdateTeam,
  Remember,
  DraftMessage,
  NeedsClarification,
]);
export type ProposalPayload = z.infer<typeof ProposalPayloadSchema>;
export type ProposalKind = ProposalPayload["kind"];
export type PayloadOf<K extends ProposalKind> = Extract<ProposalPayload, { kind: K }>;

export const PROPOSAL_LABELS: Record<ProposalKind, string> = {
  create_issue: "Create issue",
  update_issue: "Update issue",
  add_comment: "Comment",
  transition_issue: "Move",
  move_to_sprint: "Move to sprint",
  link_dependency: "Track dependency",
  update_person: "Update contact",
  update_team: "Update team",
  remember: "Remember",
  draft_message: "Draft message",
  needs_clarification: "Question",
};

/** The payload that runs: the user's edit when there is one, else the proposal as made. */
export const effectivePayload = (row: {
  readonly payload: unknown;
  readonly editedPayload: unknown;
}): ProposalPayload => (row.editedPayload ?? row.payload) as ProposalPayload;

export type IssueRefsOptions = {
  /** `"new"` keeps only `$new:n` refs, `"keys"` only real issue keys. */
  only?: "new" | "keys";
  /** Include the `$new` ref a create_issue defines, not just the ones it points at. */
  includeOwn?: boolean;
};

/**
 * Issue references a payload points at: for ordering and failure propagation,
 * for linking thread items through `$new` refs, and for keeping real keys as
 * retrieval candidates.
 */
export function issueRefs(p: ProposalPayload, opts: IssueRefsOptions = {}): string[] {
  const values: (string | null)[] = [];
  switch (p.kind) {
    case "create_issue":
      if (opts.includeOwn) values.push(p.ref);
      values.push(p.parent, p.epic);
      break;
    case "update_issue":
    case "add_comment":
    case "transition_issue":
    case "move_to_sprint":
    case "link_dependency":
      values.push(p.target);
      break;
    case "draft_message":
      values.push(...p.issueKeys);
      break;
    default:
      break;
  }
  return values.filter(
    (v): v is string =>
      !!v && (opts.only === undefined || NEW_REF_RE.test(v) === (opts.only === "new")),
  );
}

/** Replaces `$new:n` references with created keys. Unknown refs are left as they are. */
export function resolveRefs(
  p: ProposalPayload,
  created: ReadonlyMap<string, string>,
): ProposalPayload {
  const r = (v: string | null) => (v && created.has(v) ? (created.get(v) ?? v) : v);
  switch (p.kind) {
    case "create_issue":
      return { ...p, parent: r(p.parent), epic: r(p.epic) };
    case "update_issue":
    case "add_comment":
    case "transition_issue":
    case "link_dependency":
      return { ...p, target: r(p.target) ?? p.target };
    case "draft_message":
      return { ...p, issueKeys: p.issueKeys.map((k) => r(k) ?? k) };
    default:
      return p;
  }
}

/** Short human description, used on cards and for correction examples. */
export function describePayload(p: ProposalPayload): string {
  switch (p.kind) {
    case "create_issue":
      return `Create ${p.issueType} in ${p.projectKey}: ${p.summary}`;
    case "update_issue":
      return `Update ${p.target}: ${Object.keys(p.changes).join(", ")}`;
    case "add_comment":
      return `Comment on ${p.target}`;
    case "transition_issue":
      return `Move ${p.target} to ${p.toStatus}`;
    case "move_to_sprint":
      return `Move ${p.target} to sprint ${p.sprintName}`;
    case "link_dependency":
      return `${p.target} waits on ${p.label}`;
    case "update_person":
      return "Update contact profile";
    case "update_team":
      return "Update team";
    case "remember":
      return `Remember ${p.memoryKind}: ${p.content}`;
    case "draft_message":
      return `Draft ${p.intent.replace("_", " ")} (${p.channel})`;
    case "needs_clarification":
      return p.question;
  }
}

const flatFields = (p: ProposalPayload): Record<string, unknown> => {
  const { kind: _k, ...rest } = p as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) {
        if (v2 && typeof v2 === "object" && !Array.isArray(v2))
          for (const [k3, v3] of Object.entries(v2 as Record<string, unknown>)) out[k3] = v3;
        else out[k2] = v2;
      }
    } else out[k] = v;
  }
  return out;
};

const shown = (v: unknown) =>
  v === null || v === undefined || v === ""
    ? "(none)"
    : Array.isArray(v)
      ? v.join(", ")
      : String(v);

/**
 * What a correction changed, field by field, e.g. ["assignee: (none) -> ana.b"]
 * (FR-7.2). Descriptions alone can hide the change, such as a new assignee.
 */
export function payloadChanges(before: ProposalPayload, after: ProposalPayload): string[] {
  if (before.kind !== after.kind) return [`kind: ${before.kind} -> ${after.kind}`];
  const a = flatFields(before);
  const b = flatFields(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])]
    .filter((k) => k !== "ref" && JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null))
    .map((k) => `${k}: ${shown(a[k])} -> ${shown(b[k])}`);
}

/**
 * Describes one side of a stored correction example: a payload, or the list of
 * payloads a revision replaced (D22). Values that no longer parse are shown as JSON.
 */
export function describeStoredPayload(value: unknown): string {
  if (Array.isArray(value)) return value.map(describeStoredPayload).join("; ") || "nothing";
  const r = ProposalPayloadSchema.safeParse(value);
  return r.success ? describePayload(r.data) : JSON.stringify(value);
}

/** The corrected version plus exactly what changed, so an edited field is not lost. */
export function describeCorrection(before: unknown, after: unknown): string {
  const b = ProposalPayloadSchema.safeParse(before);
  const a = ProposalPayloadSchema.safeParse(after);
  if (!b.success || !a.success) return describeStoredPayload(after);
  const changes = payloadChanges(b.data, a.data);
  return changes.length
    ? `${describePayload(a.data)} (changed ${changes.join("; ")})`
    : describePayload(a.data);
}

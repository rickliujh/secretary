/**
 * Canonical proposal payloads (FR-2.2), as stored in `proposals.payload` and
 * edited in the UI. Model output is mapped to these in code; the Executor runs
 * them. `$new:n` refers to an issue created earlier in the same inbox item.
 */
import { z } from "zod";
import { CHANNELS, DETAIL, FORMALITY, RESPONSIVENESS } from "@/services/directory/schema";

export const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
export const NEW_REF_RE = /^\$new:\d+$/;

export const IssueKey = z.string().regex(ISSUE_KEY_RE, "Invalid issue key");
export const NewRef = z.string().regex(NEW_REF_RE, "Invalid $new reference");
export const IssueRef = z.union([IssueKey, NewRef]);
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

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

export const ProfileChanges = z.object({
  tone: z.string().max(200).optional(),
  formality: z.enum(FORMALITY).optional(),
  detail: z.enum(DETAIL).optional(),
  responsiveness: z.enum(RESPONSIVENESS).optional(),
  preferredChannel: z.enum(CHANNELS).optional(),
  language: z.string().max(50).optional(),
});

export const UpdatePerson = z.object({
  kind: z.literal("update_person"),
  personId: z.string().min(1),
  changes: z
    .object({
      title: z.string().trim().min(1).max(200).optional(),
      responsibilities: z.string().trim().min(1).max(2000).optional(),
      profile: ProfileChanges.optional(),
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
  subjectType: z.enum(["team", "person", "issue"]).nullable().default(null),
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
  link_dependency: "Track dependency",
  update_person: "Update contact",
  update_team: "Update team",
  remember: "Remember",
  draft_message: "Draft message",
  needs_clarification: "Question",
};

/** Issue references a payload depends on, for ordering and failure propagation. */
export function issueRefs(p: ProposalPayload): string[] {
  switch (p.kind) {
    case "create_issue":
      return [p.parent, p.epic].filter((x): x is string => !!x);
    case "update_issue":
    case "add_comment":
    case "transition_issue":
    case "link_dependency":
      return [p.target];
    case "draft_message":
      return p.issueKeys;
    default:
      return [];
  }
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

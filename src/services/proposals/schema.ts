/**
 * Canonical proposal payloads (FR-2.2), as stored in `proposals.payload` and
 * edited in the UI. Model output is mapped to these in code; the Executor runs
 * them. `$new:n` refers to an issue created earlier in the same inbox item,
 * `$person:n` and `$team:n` to a contact or team created there (D60).
 */
import { z } from "zod";
import { ProfileSchema, SUBJECT_TYPES } from "@/services/directory/schema";
import { WorkQuestionSchema } from "@/services/work/questions-schema";

export const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
export const NEW_REF_RE = /^\$new:\d+$/;

export const IssueKey = z.string().regex(ISSUE_KEY_RE, "Invalid issue key");
export const NewRef = z.string().regex(NEW_REF_RE, "Invalid $new reference");
export const IssueRef = z.union([IssueKey, NewRef]);
/** A contact or team created earlier in the same inbox item (D60). */
export const PERSON_REF_RE = /^\$person:\d+$/;
export const TEAM_REF_RE = /^\$team:\d+$/;
const ENTITY_REF_RE = /^\$(person|team):\d+$/;
export const PersonRef = z.string().regex(PERSON_REF_RE, "Invalid $person reference");
export const TeamRef = z.string().regex(TEAM_REF_RE, "Invalid $team reference");
export const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const IsoDate = z.string().regex(ISO_DATE_RE, "Use YYYY-MM-DD");

export const ISSUE_TYPES = ["Epic", "Story", "Task", "Sub-task", "Bug"] as const;
/** Story points a proposal may set (D55). */
export const MAX_STORY_POINTS = 1000;
export const StoryPoints = z.number().min(0).max(MAX_STORY_POINTS);
export const DEPENDENCY_KINDS = ["person", "team", "incident", "external"] as const;
/** How a follow-up on a dependency happened (its timeline, FR-3.1). */
export const FOLLOWUP_CHANNELS = ["teams", "email", "meeting", "phone", "jira", "other"] as const;
/** What intake may do to an open dependency (D46). */
export const WAIT_ACTIONS = ["log_reply", "reschedule", "resolve"] as const;
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
  /** Jira labels sent on create; a small ask carries the home's label (D44). */
  labels: z
    .array(z.string().trim().min(1).regex(/^\S+$/, "Labels cannot contain spaces"))
    .default([]),
  /** A small ask (FR-10): code set the project, label, assignee and sprint flag. */
  smallAsk: z.boolean().default(false),
  /** The contact who asked; stored on the created issue's `issue_meta` (FR-10.4). */
  requesterPersonId: z.string().min(1).nullable().default(null),
  /**
   * Move the created issue into the user's active sprint (D44, D57); sub-tasks
   * follow their parent and Epics never join. Code's field, not the model's.
   */
  joinSprint: z.boolean().default(false),
  /** The user set `joinSprint` (D57): revisions and re-triage keep it instead of recomputing it. */
  joinSprintChosen: z.boolean().default(false),
  /** Story points to set on create (D55); null for none. */
  storyPoints: StoryPoints.nullable().default(null),
  /** True only while the points are the model's suggestion; any edit of them sets it false. */
  storyPointsEstimated: z.boolean().default(false),
  /**
   * The user cleared the points: a revision keeps them empty, with no estimate
   * or small-ask default, unless the user's instructions give a number.
   */
  storyPointsCleared: z.boolean().default(false),
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
      /** New story points; null clears them (D55). */
      storyPoints: StoryPoints.nullable().optional(),
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

/**
 * "target is blocked by blocker" as a Jira issue link (FR-3.8, D45): the target
 * waits until the blocker is done. Both are candidates or `$new` refs.
 */
export const LinkIssues = z
  .object({
    kind: z.literal("link_issues"),
    target: IssueRef,
    blocker: IssueRef,
  })
  .refine((p) => p.target !== p.blocker, {
    message: "An issue cannot block itself",
    path: ["blocker"],
  });

/**
 * A change to an open dependency from intake (FR-3.7, D46): log their reply on
 * its timeline, give it a new date, or resolve it. The id is one of the open
 * dependencies retrieval offered; `issueKey`, `label` and `channel` are set by
 * code from that dependency and the input's source, for the card and timeline.
 */
export const UpdateDependency = z
  .object({
    kind: z.literal("update_dependency"),
    dependencyId: z.string().min(1),
    action: z.enum(WAIT_ACTIONS),
    /** What they said or what changed: the timeline entry. */
    summary: z.string().trim().min(1).max(2000).nullable().default(null),
    expectedAt: IsoDate.nullable().default(null),
    nextFollowupAt: IsoDate.nullable().default(null),
    channel: z.enum(FOLLOWUP_CHANNELS).default("other"),
    issueKey: IssueKey.nullable().default(null),
    label: z.string().nullable().default(null),
  })
  .refine((p) => p.action !== "reschedule" || !!p.expectedAt || !!p.nextFollowupAt, {
    message: "A reschedule needs a new expected date or follow-up date",
    path: ["expectedAt"],
  });

export const UpdatePerson = z.object({
  kind: z.literal("update_person"),
  personId: z.string().min(1),
  changes: z
    .object({
      title: z.string().trim().min(1).max(200).optional(),
      responsibilities: z.string().trim().min(1).max(2000).optional(),
      profile: ProfileSchema.optional(),
      /** Last day away, from an out-of-office reply (D47). */
      awayUntil: IsoDate.optional(),
      /** The team they move to (D60): a team id, a `$team:n` ref, or null to remove them. */
      team: z.string().min(1).nullable().optional(),
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

const optionalText = (max: number) => z.string().trim().min(1).max(max).nullable().default(null);

/** A new team (FR-18, D60); `ref` lets other proposals of the item use it before it exists. */
export const CreateTeam = z.object({
  kind: z.literal("create_team"),
  ref: TeamRef,
  name: z.string().trim().min(1).max(200),
  function: optionalText(500),
  contactFor: optionalText(1000),
  channel: optionalText(200),
  escalationPath: optionalText(1000),
  /** Goes to the team's notes. */
  note: optionalText(20000),
});

/** A new contact (FR-18, D60); `team` is a team id or a `$team:n` of the same item. */
export const CreatePerson = z.object({
  kind: z.literal("create_person"),
  ref: PersonRef,
  displayName: z.string().trim().min(1).max(200),
  title: optionalText(200),
  email: z.email().nullable().default(null),
  jiraUsername: optionalText(200),
  team: z.string().min(1).nullable().default(null),
  responsibilities: optionalText(2000),
  profile: ProfileSchema.default({}),
  /** Goes to the contact's notes. */
  note: optionalText(20000),
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
  /** Answers the user can pick with one click; any typed reply still answers (D61). */
  choices: z.array(z.string().trim().min(1)).default([]),
  /** Set on a work model question (D61): its answer goes to the work model, not to classify. */
  work: WorkQuestionSchema.optional(),
});

export const ProposalPayloadSchema = z.discriminatedUnion("kind", [
  CreateIssue,
  UpdateIssue,
  AddComment,
  TransitionIssue,
  MoveToSprint,
  LinkDependency,
  LinkIssues,
  UpdateDependency,
  UpdatePerson,
  UpdateTeam,
  CreateTeam,
  CreatePerson,
  Remember,
  DraftMessage,
  NeedsClarification,
]);
export type ProposalPayload = z.infer<typeof ProposalPayloadSchema>;
/** A payload as it may be stored: fields added later can be missing (they have defaults). */
export type StoredProposalPayload = z.input<typeof ProposalPayloadSchema>;
export type ProposalKind = ProposalPayload["kind"];
export type PayloadOf<K extends ProposalKind> = Extract<ProposalPayload, { kind: K }>;

export const PROPOSAL_LABELS: Record<ProposalKind, string> = {
  create_issue: "Create issue",
  update_issue: "Update issue",
  add_comment: "Comment",
  transition_issue: "Move",
  move_to_sprint: "Move to sprint",
  link_dependency: "Track dependency",
  link_issues: "Blocked by",
  update_dependency: "Update wait",
  update_person: "Update contact",
  update_team: "Update team",
  create_team: "New team",
  create_person: "New contact",
  remember: "Remember",
  draft_message: "Draft message",
  needs_clarification: "Question",
};

/**
 * A stored payload with the defaults of fields added since it was stored, so
 * proposals made before a schema change still load, edit and execute. A value
 * that no longer parses is returned as it is; approving it fails validation.
 */
export function parsePayload(value: unknown): ProposalPayload {
  const r = ProposalPayloadSchema.safeParse(value);
  return r.success ? r.data : (value as ProposalPayload);
}

/** The payload that runs: the user's edit when there is one, else the proposal as made. */
export const effectivePayload = (row: {
  readonly payload: unknown;
  readonly editedPayload: unknown;
}): ProposalPayload => parsePayload(row.editedPayload ?? row.payload);

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
    case "link_issues":
      values.push(p.target, p.blocker);
      break;
    case "update_dependency":
      values.push(p.issueKey);
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

/**
 * Fields holding a contact or team (D60): ids, or `$person:n` / `$team:n` refs
 * to creates of the same item. A memory's subject counts only when it is one.
 */
export function directoryRefs(p: ProposalPayload): string[] {
  const values: (string | null | undefined)[] = [];
  switch (p.kind) {
    case "create_person":
      values.push(p.team);
      break;
    case "update_person":
      values.push(p.personId, p.changes.team);
      break;
    case "update_team":
      values.push(p.teamId);
      break;
    case "link_dependency":
      values.push(p.ownerPersonId, p.ownerTeamId);
      break;
    case "draft_message":
      values.push(p.recipientPersonId, p.recipientTeamId);
      break;
    case "remember":
      if (p.subjectType === "person" || p.subjectType === "team") values.push(p.subjectId);
      break;
    default:
      break;
  }
  return values.filter((v): v is string => !!v);
}

/** The ref a create defines (`$new:n`, `$person:n`, `$team:n`), or null. */
export const ownRef = (p: ProposalPayload): string | null =>
  p.kind === "create_issue" || p.kind === "create_person" || p.kind === "create_team"
    ? p.ref
    : null;

/**
 * What a thread's executed creates made, by their ref (D22, D60): issue keys by
 * `$new` ref, contact and team ids by `$person` and `$team` ref, from results.
 */
export function createdIds(
  rows: readonly { status: string; payload: unknown; editedPayload: unknown; result: unknown }[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of rows) {
    if (r.status !== "executed") continue;
    const p = effectivePayload(r);
    const res = (r.result ?? {}) as { issueKey?: unknown; personId?: unknown; teamId?: unknown };
    const made =
      p.kind === "create_issue"
        ? res.issueKey
        : p.kind === "create_person"
          ? res.personId
          : p.kind === "create_team"
            ? res.teamId
            : undefined;
    const ref = ownRef(p);
    if (ref && typeof made === "string" && made) map.set(ref, made);
  }
  return map;
}

/** `$person:n` and `$team:n` refs a payload points at (D60), not the one it defines. */
export const directoryPlaceholders = (p: ProposalPayload): string[] =>
  directoryRefs(p).filter((v) => ENTITY_REF_RE.test(v));

/**
 * Every placeholder ref a payload points at (D22, D60): `$new:n` issues and
 * `$person:n` / `$team:n` contacts and teams; with `includeOwn`, the one it defines.
 */
export function placeholderRefs(p: ProposalPayload, opts: { includeOwn?: boolean } = {}): string[] {
  const own = opts.includeOwn ? ownRef(p) : null;
  return [
    ...new Set([
      ...(own ? [own] : []),
      ...issueRefs(p, { only: "new" }),
      ...directoryPlaceholders(p),
    ]),
  ];
}

/**
 * Replaces placeholder refs with what their creates made: `$new:n` with issue
 * keys, `$person:n` and `$team:n` with contact and team ids (D60). Unknown refs
 * are left as they are; a create's own ref is never replaced.
 */
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
      return { ...p, target: r(p.target) ?? p.target };
    case "link_dependency":
      return {
        ...p,
        target: r(p.target) ?? p.target,
        ownerPersonId: r(p.ownerPersonId),
        ownerTeamId: r(p.ownerTeamId),
      };
    case "link_issues":
      return { ...p, target: r(p.target) ?? p.target, blocker: r(p.blocker) ?? p.blocker };
    case "draft_message":
      return {
        ...p,
        issueKeys: p.issueKeys.map((k) => r(k) ?? k),
        recipientPersonId: r(p.recipientPersonId),
        recipientTeamId: r(p.recipientTeamId),
      };
    case "remember":
      return { ...p, subjectId: r(p.subjectId) };
    case "create_person":
      return { ...p, team: r(p.team) };
    case "update_person":
      return typeof p.changes.team === "string"
        ? { ...p, changes: { ...p.changes, team: r(p.changes.team) } }
        : p;
    default:
      return p;
  }
}

/** "1 point", "3 points", "0.5 points" (D55). */
export const pointsLabel = (n: number) => `${n} ${n === 1 ? "point" : "points"}`;

/** Short human description, used on cards and for correction examples. */
export function describePayload(p: ProposalPayload): string {
  switch (p.kind) {
    case "create_issue": {
      const points =
        typeof p.storyPoints === "number"
          ? `, ${pointsLabel(p.storyPoints)}${p.storyPointsEstimated ? " (suggested)" : ""}`
          : "";
      return `Create ${p.issueType} in ${p.projectKey}: ${p.summary}${points}`;
    }
    case "update_issue":
      return `Update ${p.target}: ${Object.entries(p.changes)
        .map(([k, v]) =>
          k !== "storyPoints" ? k : typeof v === "number" ? pointsLabel(v) : "clear story points",
        )
        .join(", ")}`;
    case "add_comment":
      return `Comment on ${p.target}`;
    case "transition_issue":
      return `Move ${p.target} to ${p.toStatus}`;
    case "move_to_sprint":
      return `Move ${p.target} to sprint ${p.sprintName}`;
    case "link_dependency":
      return `${p.target} waits on ${p.label}`;
    case "link_issues":
      return `${p.target} is blocked by ${p.blocker}`;
    case "update_dependency":
      return describeWaitUpdate(p);
    case "update_person":
      return p.changes.awayUntil
        ? `Away until ${p.changes.awayUntil}`
        : p.changes.team === null
          ? "Remove from their team"
          : p.changes.team
            ? "Move to another team"
            : "Update contact profile";
    case "update_team":
      return "Update team";
    case "create_team":
      return `Add team ${p.name}`;
    case "create_person":
      return `Add contact ${p.displayName}${p.title ? `, ${p.title}` : ""}`;
    case "remember":
      return `Remember ${p.memoryKind}: ${p.content}`;
    case "draft_message":
      return `Draft ${p.intent.replace("_", " ")} (${p.channel})`;
    case "needs_clarification":
      return p.question;
  }
}

/** "Resolve: PAY-2 waits on numbers from finance" (D46). */
export function describeWaitUpdate(p: PayloadOf<"update_dependency">): string {
  const what = p.label ? `${p.issueKey ? `${p.issueKey} waits on ` : ""}${p.label}` : "a wait";
  switch (p.action) {
    case "resolve":
      return `Resolve: ${what}`;
    case "log_reply":
      return `Log reply on ${what}${p.expectedAt ? `, expected ${p.expectedAt}` : ""}`;
    case "reschedule":
      return `Reschedule ${what}: ${[
        p.expectedAt && `expected ${p.expectedAt}`,
        p.nextFollowupAt && `ask again ${p.nextFollowupAt}`,
      ]
        .filter(Boolean)
        .join(", ")}`;
  }
}

/**
 * Fields code sets and the user switches on the card (D57): not something the
 * model proposes, so corrections leave them out.
 */
export const CODE_ONLY_FIELDS = ["joinSprint", "joinSprintChosen"] as const;

/** A payload without `CODE_ONLY_FIELDS`, for correction examples (FR-7.2, D57). */
export function withoutCodeFields<T extends ProposalPayload>(p: T): T {
  if (p.kind !== "create_issue") return p;
  const out: Record<string, unknown> = { ...p };
  for (const k of CODE_ONLY_FIELDS) delete out[k];
  return out as T;
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
    .filter(
      (k) =>
        k !== "ref" &&
        !(CODE_ONLY_FIELDS as readonly string[]).includes(k) &&
        JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null),
    )
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

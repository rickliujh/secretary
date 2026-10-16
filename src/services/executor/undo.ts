/**
 * Undo data (D54 (1)): what the Executor records in a proposal's result, read
 * just before it writes, so the approval can be revoked later. Kinds whose
 * result already holds the ids they made (create_issue, link_dependency,
 * remember, draft_message) record nothing here; a new contact or team records
 * what was written (D60).
 */
import { z } from "zod";
import { parseSprints } from "@/services/jira/mapping";
import { NamedSchema, StatusSchema, UserRefSchema } from "@/services/jira/schemas";

/** The issue fields update_issue sets, as comparable values: names and user ids. */
export const IssueFieldValuesSchema = z.object({
  summary: z.string().optional(),
  priority: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  assignee: z.string().nullable().optional(),
  /** Read from the story point field the approval wrote (D55). */
  storyPoints: z.number().nullable().optional(),
});
export type IssueFieldValues = z.infer<typeof IssueFieldValuesSchema>;
export type IssueField = keyof IssueFieldValues;

/** Jira field ids to read for each comparable field; story points live in a custom field. */
export const ISSUE_FIELD_IDS: Record<Exclude<IssueField, "storyPoints">, string> = {
  summary: "summary",
  priority: "priority",
  dueDate: "duedate",
  assignee: "assignee",
};

/** The Jira field ids holding `keys`; story points only when their field is known. */
export const issueFieldIds = (keys: readonly IssueField[], pointsField?: string): string[] =>
  keys.flatMap((k) =>
    k === "storyPoints" ? (pointsField ? [pointsField] : []) : [ISSUE_FIELD_IDS[k]],
  );

/** A wait's state columns that update_dependency changes (D46). */
export const WaitStateSchema = z.object({
  status: z.enum(["open", "waiting", "blocked", "resolved"]),
  expectedAt: z.string().nullable(),
  nextFollowupAt: z.string().nullable(),
  resolvedAt: z.string().nullable(),
  notifiedOn: z.string().nullable(),
});
export type WaitState = z.infer<typeof WaitStateSchema>;

const SprintRefSchema = z.object({ id: z.number(), name: z.string() });
export type SprintRef = z.infer<typeof SprintRefSchema>;

const Values = z.record(z.string(), z.unknown());

export const UndoSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("update_issue"),
    issueKey: z.string(),
    before: IssueFieldValuesSchema,
    /** What the approval set, to tell a later change by someone else (FR-14.3). */
    after: IssueFieldValuesSchema,
    /** Display names of the users in `before`, by user id, for the revoke's texts. */
    names: z.record(z.string(), z.string()).optional(),
    /** The story point field the approval wrote, to read and restore the same one (D55). */
    pointsField: z.string().optional(),
  }),
  z.object({
    kind: z.literal("transition_issue"),
    issueKey: z.string(),
    fromStatus: z.string(),
    toStatus: z.string(),
  }),
  z.object({
    kind: z.literal("move_to_sprint"),
    issueKey: z.string(),
    /** False when the issue was already in the sprint and nothing was written. */
    moved: z.boolean(),
    sprintId: z.number(),
    /** The open sprint it was in before; null = the backlog; missing = not known. */
    previous: SprintRefSchema.nullable().optional(),
  }),
  z.object({ kind: z.literal("add_comment"), issueKey: z.string(), commentId: z.string() }),
  z.object({
    kind: z.literal("link_issues"),
    issueKey: z.string(),
    /** The link this approval made; null when Jira already had it. */
    linkId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("update_dependency"),
    dependencyId: z.string(),
    /** Null when nothing changed (the wait was already resolved). */
    before: WaitStateSchema.nullable(),
    after: WaitStateSchema.nullable(),
    /** The timeline entry this approval added. */
    followupId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("update_person"),
    personId: z.string(),
    before: Values,
    after: Values,
  }),
  z.object({ kind: z.literal("update_team"), teamId: z.string(), before: Values, after: Values }),
  /**
   * A contact or team an approval added (D60): its id and the values written, so a
   * revoke deletes it only while it is as it was added.
   */
  z.object({ kind: z.literal("create_person"), id: z.string(), created: Values }),
  z.object({ kind: z.literal("create_team"), id: z.string(), created: Values }),
]);
export type Undo = z.infer<typeof UndoSchema>;
export type UndoOf<K extends Undo["kind"]> = Extract<Undo, { kind: K }>;

/** The undo data in a stored result, or null when there is none (or it no longer parses). */
export function undoOf(result: unknown): Undo | null {
  const raw = (result as { undo?: unknown } | null)?.undo;
  if (raw === undefined) return null;
  const r = UndoSchema.safeParse(raw);
  return r.success ? r.data : null;
}

const parse = <T>(schema: z.ZodType<T>, value: unknown): T | undefined => {
  const r = schema.safeParse(value);
  return r.success ? r.data : undefined;
};

/** The comparable values of `keys` in an issue's raw fields; story points from `pointsField`. */
export function issueFieldValues(
  fields: Record<string, unknown>,
  keys: readonly IssueField[],
  pointsField?: string,
): IssueFieldValues {
  const out: IssueFieldValues = {};
  for (const k of keys) {
    if (k === "storyPoints") {
      const v = pointsField ? fields[pointsField] : null;
      out.storyPoints = typeof v === "number" ? v : null;
      continue;
    }
    const v = fields[ISSUE_FIELD_IDS[k]];
    if (k === "summary") out.summary = typeof v === "string" ? v : "";
    if (k === "priority") out.priority = parse(NamedSchema, v)?.name ?? null;
    if (k === "dueDate") out.dueDate = typeof v === "string" && v ? v : null;
    if (k === "assignee") out.assignee = parse(UserRefSchema, v)?.id ?? null;
  }
  return out;
}

/** The display name of the user in each of `keys` that holds one (the assignee), by user id. */
export function issueUserNames(
  fields: Record<string, unknown>,
  keys: readonly IssueField[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of keys) {
    if (k !== "assignee") continue;
    const u = parse(UserRefSchema, fields[ISSUE_FIELD_IDS[k]]);
    if (u) out[u.id] = u.displayName;
  }
  return out;
}

/** The status name and category of an issue's raw fields. */
export function issueStatus(fields: Record<string, unknown>): {
  name: string;
  category: string;
} | null {
  const s = parse(StatusSchema, fields.status);
  return s ? { name: s.name, category: s.statusCategory.key } : null;
}

/**
 * The open sprint an issue is in, from its Sprint field: the active one, else a
 * future one. An issue whose sprints are all closed is in the backlog (null).
 */
export function openSprint(sprintField: unknown): SprintRef | null {
  const sprints = parseSprints(sprintField);
  const s = sprints.find((x) => x.state === "active") ?? sprints.find((x) => x.state === "future");
  return s ? { id: s.id, name: s.name } : null;
}

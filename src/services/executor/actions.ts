/**
 * Jira actions the Executor can perform. Phase 1 uses them for explicit user
 * actions in the ticket view; Phase 3 proposals map onto the same shapes.
 */
import { z } from "zod";

const IssueKey = z.string().regex(/^[A-Z][A-Z0-9_]+-\d+$/, "Invalid issue key");
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const JiraActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("add_comment"),
    issueKey: IssueKey,
    bodyMarkdown: z.string().trim().min(1),
  }),
  z.object({
    kind: z.literal("transition"),
    issueKey: IssueKey,
    transitionId: z.string().min(1),
    transitionName: z.string().optional(),
  }),
  z.object({
    kind: z.literal("update_fields"),
    issueKey: IssueKey,
    fields: z
      .object({
        summary: z.string().trim().min(1).optional(),
        /** Wiki markup; edited as-is to avoid lossy round trips (design.md section 5). */
        descriptionWiki: z.string().nullable().optional(),
        priority: z.string().min(1).optional(),
        dueDate: IsoDate.nullable().optional(),
      })
      .refine((f) => Object.keys(f).length > 0, "Nothing to update"),
  }),
  z.object({
    kind: z.literal("assign"),
    issueKey: IssueKey,
    username: z.string().min(1).nullable(),
  }),
  z.object({ kind: z.literal("set_epic"), issueKey: IssueKey, epicKey: IssueKey.nullable() }),
]);
export type JiraAction = z.infer<typeof JiraActionSchema>;

export function describeAction(a: JiraAction): string {
  switch (a.kind) {
    case "add_comment":
      return `Comment on ${a.issueKey}`;
    case "transition":
      return `Move ${a.issueKey}${a.transitionName ? ` to ${a.transitionName}` : ""}`;
    case "update_fields":
      return `Update ${Object.keys(a.fields).join(", ")} on ${a.issueKey}`;
    case "assign":
      return a.username ? `Assign ${a.issueKey} to ${a.username}` : `Unassign ${a.issueKey}`;
    case "set_epic":
      return a.epicKey
        ? `Link ${a.issueKey} to epic ${a.epicKey}`
        : `Remove epic from ${a.issueKey}`;
  }
}

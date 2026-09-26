/**
 * Jira actions the Executor can perform: explicit user actions in the ticket
 * view, and approved proposals mapped onto the same shapes.
 */
import { z } from "zod";
import { IsoDate, IssueKey } from "@/services/proposals/schema";

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
  /** Creates or updates (same globalId) a remote link mirroring a dependency (FR-3.4). */
  z.object({
    kind: z.literal("upsert_remote_link"),
    issueKey: IssueKey,
    globalId: z.string().min(1),
    url: z.string().min(1),
    title: z.string().trim().min(1),
    summary: z.string().optional(),
    resolved: z.boolean(),
  }),
  z.object({
    kind: z.literal("delete_remote_link"),
    issueKey: IssueKey,
    globalId: z.string().min(1),
  }),
  /** Moves the issue into a sprint through the Agile API (D30). */
  z.object({
    kind: z.literal("move_to_sprint"),
    issueKey: IssueKey,
    sprintId: z.number().int().positive(),
    sprintName: z.string().optional(),
  }),
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
    case "upsert_remote_link":
      return `Mirror "${a.title}" on ${a.issueKey}`;
    case "delete_remote_link":
      return `Remove mirrored dependency from ${a.issueKey}`;
    case "move_to_sprint":
      return `Move ${a.issueKey} to sprint ${a.sprintName ?? a.sprintId}`;
  }
}

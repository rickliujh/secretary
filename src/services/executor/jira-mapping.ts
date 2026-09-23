/**
 * Pure mapping from actions to Jira DC REST v2 write requests (design.md 7.3).
 */
import { markdownToWiki } from "@/lib/wiki";
import type { EditMeta, JiraWrite } from "@/services/jira";
import type { FieldIds } from "@/services/jira/fields";
import type { JiraAction } from "./actions";

export type MappingContext = {
  fieldIds: FieldIds;
  /** Needed for `set_epic` to pick Epic Link vs parent. */
  editMeta?: EditMeta;
};

export class MappingError extends Error {}

const issuePath = (key: string, suffix = "") => `issue/${encodeURIComponent(key)}${suffix}`;

export function buildJiraWrite(action: JiraAction, ctx: MappingContext): JiraWrite {
  switch (action.kind) {
    case "add_comment":
      return {
        method: "POST",
        path: issuePath(action.issueKey, "/comment"),
        body: { body: markdownToWiki(action.bodyMarkdown) },
      };
    case "transition":
      return {
        method: "POST",
        path: issuePath(action.issueKey, "/transitions"),
        body: { transition: { id: action.transitionId } },
      };
    case "update_fields": {
      const f = action.fields;
      const fields: Record<string, unknown> = {};
      if (f.summary !== undefined) fields.summary = f.summary;
      if (f.descriptionWiki !== undefined) fields.description = f.descriptionWiki;
      if (f.priority !== undefined) fields.priority = { name: f.priority };
      if (f.dueDate !== undefined) fields.duedate = f.dueDate;
      return { method: "PUT", path: issuePath(action.issueKey), body: { fields } };
    }
    case "assign":
      return {
        method: "PUT",
        path: issuePath(action.issueKey, "/assignee"),
        body: { name: action.username },
      };
    case "set_epic": {
      const editable = ctx.editMeta?.fields ?? {};
      const epicLink = ctx.fieldIds.epicLink;
      if (epicLink && (!ctx.editMeta || epicLink in editable)) {
        return {
          method: "PUT",
          path: issuePath(action.issueKey),
          body: { fields: { [epicLink]: action.epicKey } },
        };
      }
      if ("parent" in editable) {
        return {
          method: "PUT",
          path: issuePath(action.issueKey),
          body: { fields: { parent: action.epicKey ? { key: action.epicKey } : null } },
        };
      }
      throw new MappingError(`Neither Epic Link nor parent can be edited on ${action.issueKey}.`);
    }
  }
}

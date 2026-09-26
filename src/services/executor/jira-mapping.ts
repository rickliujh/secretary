/**
 * Pure mapping from actions to Jira REST v2 and Agile 1.0 write requests
 * (design.md 7.3).
 */
import { markdownToWiki } from "@/lib/wiki";
import type { Deployment } from "@/services/atlassian/deployment";
import type { EditMeta, JiraWrite } from "@/services/jira";
import type { FieldIds } from "@/services/jira/fields";
import type { JiraAction } from "./actions";

export type MappingContext = {
  /** Cloud identifies users by accountId and links epics with `parent` (D19). Defaults to Data Center. */
  deployment?: Deployment;
  fieldIds: FieldIds;
  /** Needed for `set_epic` to pick Epic Link vs parent. */
  editMeta?: EditMeta;
};

export class MappingError extends Error {}

const issuePath = (key: string, suffix = "") => `issue/${encodeURIComponent(key)}${suffix}`;

/** The Agile API accepts at most this many issues per move (Cloud and Data Center). */
export const MAX_SPRINT_MOVE_ISSUES = 50;

/**
 * `POST /rest/agile/1.0/sprint/{sprintId}/issue`: moves up to 50 issues into a
 * sprint, taking them out of any other open sprint.
 */
export function buildMoveToSprint(sprintId: number, issueKeys: readonly string[]): JiraWrite {
  if (!Number.isInteger(sprintId) || sprintId <= 0)
    throw new MappingError(`Invalid sprint id ${sprintId}.`);
  if (issueKeys.length === 0) throw new MappingError("No issues to move.");
  if (issueKeys.length > MAX_SPRINT_MOVE_ISSUES)
    throw new MappingError(
      `Jira moves at most ${MAX_SPRINT_MOVE_ISSUES} issues into a sprint at once (got ${issueKeys.length}).`,
    );
  return {
    method: "POST",
    api: "agile",
    path: `sprint/${sprintId}/issue`,
    body: { issues: [...issueKeys] },
  };
}

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
        body:
          ctx.deployment === "cloud" ? { accountId: action.username } : { name: action.username },
      };
    case "set_epic": {
      if (ctx.deployment === "cloud") {
        // Cloud retired Epic Link for the system `parent` field; removal uses the documented update form.
        return {
          method: "PUT",
          path: issuePath(action.issueKey),
          body: action.epicKey
            ? { fields: { parent: { key: action.epicKey } } }
            : { update: { parent: [{ set: { none: true } }] } },
        };
      }
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
    case "upsert_remote_link":
      return {
        method: "POST",
        path: issuePath(action.issueKey, "/remotelink"),
        body: {
          // Posting the same globalId again updates the link instead of adding one.
          globalId: action.globalId,
          application: { type: "secretary", name: "Secretary" },
          relationship: "waits on",
          object: {
            url: action.url,
            title: action.title,
            ...(action.summary ? { summary: action.summary } : {}),
            status: { resolved: action.resolved },
          },
        },
      };
    case "delete_remote_link":
      return {
        method: "DELETE",
        path: `${issuePath(action.issueKey, "/remotelink")}?globalId=${encodeURIComponent(action.globalId)}`,
      };
    case "move_to_sprint":
      return buildMoveToSprint(action.sprintId, [action.issueKey]);
  }
}

// ---------------------------------------------------------------------------
// Issue creation (proposals of kind create_issue)
// ---------------------------------------------------------------------------

export type CreateIssueInput = {
  projectKey: string;
  issueTypeId: string;
  issueTypeName: string;
  summary: string;
  descriptionMd: string | null;
  /** Resolved keys (no `$new` refs). */
  parent: string | null;
  epic: string | null;
  priority: string | null;
  assignee: string | null;
  dueDate: string | null;
};

export type CreateContext = {
  deployment?: Deployment;
  fieldIds: FieldIds;
  /** Create metadata for the project and issue type. */
  fields: readonly {
    fieldId: string;
    name: string;
    required: boolean;
    hasDefaultValue?: boolean;
  }[];
};

export type CreatePlan = {
  request: JiraWrite;
  /** Epic to link after creation when Jira does not accept it on the create screen. */
  epicAfterCreate: string | null;
};

// Fields Jira fills itself or that the app always sends.
const IMPLICIT_FIELDS = new Set(["project", "issuetype", "summary", "reporter"]);

export function buildCreateIssue(input: CreateIssueInput, ctx: CreateContext): CreatePlan {
  const allowed = new Set(ctx.fields.map((f) => f.fieldId));
  const fields: Record<string, unknown> = {
    project: { key: input.projectKey },
    issuetype: { id: input.issueTypeId },
    summary: input.summary,
  };
  const set = (fieldId: string, value: unknown) => {
    if (allowed.has(fieldId)) fields[fieldId] = value;
  };
  if (input.descriptionMd) set("description", markdownToWiki(input.descriptionMd));
  if (input.priority) set("priority", { name: input.priority });
  if (input.assignee)
    set("assignee", ctx.deployment === "cloud" ? { id: input.assignee } : { name: input.assignee });
  if (input.dueDate) set("duedate", input.dueDate);

  const isSubtask = /sub-?task/i.test(input.issueTypeName);
  if (isSubtask) {
    if (!input.parent) throw new MappingError("A sub-task needs a parent issue.");
    fields.parent = { key: input.parent };
  }

  let epicAfterCreate: string | null = null;
  if (input.epic && !isSubtask) {
    const epicLink = ctx.deployment === "cloud" ? undefined : ctx.fieldIds.epicLink;
    if (epicLink && allowed.has(epicLink)) fields[epicLink] = input.epic;
    else if (allowed.has("parent")) fields.parent = { key: input.epic };
    else epicAfterCreate = input.epic;
  }
  // Classic Jira Software requires an Epic Name when creating an Epic.
  if (
    /^epic$/i.test(input.issueTypeName) &&
    ctx.fieldIds.epicName &&
    allowed.has(ctx.fieldIds.epicName)
  ) {
    fields[ctx.fieldIds.epicName] = input.summary;
  }

  const missing = ctx.fields
    .filter(
      (f) =>
        f.required &&
        !f.hasDefaultValue &&
        !IMPLICIT_FIELDS.has(f.fieldId) &&
        !(f.fieldId in fields),
    )
    .map((f) => f.name);
  if (missing.length) {
    throw new MappingError(
      `Jira requires ${missing.join(", ")} for a ${input.issueTypeName} in ${input.projectKey}. Create it in Jira, or edit the proposal once these can be set.`,
    );
  }
  return { request: { method: "POST", path: "issue", body: { fields } }, epicAfterCreate };
}

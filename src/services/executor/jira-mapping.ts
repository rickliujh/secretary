/**
 * Pure mapping from actions to Jira REST v2 and Agile 1.0 write requests
 * (design.md 7.3).
 */
import { markdownToWiki } from "@/lib/wiki";
import { balanceBlockMarkers, sanitiseProposalWiki, type WikiSafety } from "@/lib/wiki-safe";
import type { Deployment } from "@/services/atlassian/deployment";
import type { EditMeta, JiraWrite } from "@/services/jira";
import { type FieldIds, pointsFieldOn } from "@/services/jira/fields";
import { pointsLabel } from "@/services/proposals/schema";
import { literalWiki, provenanceLineWiki, splitProvenance } from "@/services/small-asks/home";
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

/**
 * The Team field's value to write (D59): Cloud takes the team's id as a
 * string; Data Center (Advanced Roadmaps) a number when the id is numeric.
 */
export function teamFieldValue(id: string | null, deployment: Deployment = "datacenter") {
  if (id === null) return null;
  return deployment === "datacenter" && /^\d+$/.test(id) ? Number(id) : id;
}

export function buildJiraWrite(action: JiraAction, ctx: MappingContext): JiraWrite {
  switch (action.kind) {
    case "add_comment":
      return {
        method: "POST",
        path: issuePath(action.issueKey, "/comment"),
        // A proposal's body arrives converted and made safe (D51); the user's own is converted here.
        body: { body: action.bodyWiki ?? markdownToWiki(action.bodyMarkdown) },
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
      if (f.labels !== undefined) fields.labels = f.labels;
      if (f.team !== undefined) {
        if (!ctx.fieldIds.team)
          throw new MappingError(
            `No Team field was found in Jira, so the team of ${action.issueKey} cannot be set. Set the field in Settings > Jira, or leave the team as it was.`,
          );
        // Found only by its name it may be a select list, which a team id would break (D59).
        if (!ctx.fieldIds.teamEditable)
          throw new MappingError(
            `The field ${ctx.fieldIds.team} is named Team but is not a Jira team field, so the team of ${action.issueKey} cannot be set. If it does take a team, set it in Settings > Jira; otherwise leave the team as it was.`,
          );
        fields[ctx.fieldIds.team] = teamFieldValue(f.team, ctx.deployment);
      }
      if (f.storyPoints !== undefined) {
        if (!action.pointsField)
          throw new MappingError(`No story point field to write on ${action.issueKey}.`);
        fields[action.pointsField] = f.storyPoints;
      }
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
    case "link_issues": {
      // On the target, Jira lists the blocker as its `inwardIssue` ("is blocked
      // by"); posting it as the inward issue is meant to create that. Some
      // instances store it the other way, so the Executor checks and swaps (D45).
      const [inward, outward] = action.swapped
        ? [action.issueKey, action.blockerKey]
        : [action.blockerKey, action.issueKey];
      return {
        method: "POST",
        path: "issueLink",
        body: {
          type: { name: action.linkType },
          inwardIssue: { key: inward },
          outwardIssue: { key: outward },
        },
      };
    }
    case "delete_issue_link":
      return { method: "DELETE", path: `issueLink/${encodeURIComponent(action.linkId)}` };
    case "delete_issue":
      // No deleteSubtasks: a ticket with sub-tasks is closed instead (D54).
      return { method: "DELETE", path: issuePath(action.issueKey) };
    case "delete_comment":
      return {
        method: "DELETE",
        path: issuePath(action.issueKey, `/comment/${encodeURIComponent(action.commentId)}`),
      };
    case "move_to_backlog":
      return {
        method: "POST",
        api: "agile",
        path: "backlog/issue",
        body: { issues: [action.issueKey] },
      };
  }
}

// ---------------------------------------------------------------------------
// Issue creation (proposals of kind create_issue)
// ---------------------------------------------------------------------------

export type CreateIssueInput = {
  projectKey: string;
  issueTypeId: string;
  issueTypeName: string;
  /** Jira's sub-task flag for the type (create metadata); the name decides only when it is unknown. */
  subtask?: boolean;
  summary: string;
  descriptionMd: string | null;
  /** Resolved keys (no `$new` refs). */
  parent: string | null;
  epic: string | null;
  priority: string | null;
  assignee: string | null;
  dueDate: string | null;
  /** Sent when the create screen has a Labels field (D44). */
  labels?: readonly string[];
  /** Written to the first story point field on the create screen (D55); never on an Epic. */
  storyPoints?: number | null;
};

export type CreateContext = {
  deployment?: Deployment;
  /** Jira users a mention in the description may name (D51); others become text. */
  knownUsers?: readonly (string | null)[];
  fieldIds: FieldIds;
  /** Create metadata for the project and issue type. */
  fields: readonly {
    fieldId: string;
    name: string;
    required: boolean;
    hasDefaultValue?: boolean;
  }[];
};

/** Values asked for that the create screen has no field for, so they were not sent. */
export type DroppedFields = {
  labels: string[];
  assignee: string | null;
  description: boolean;
  /** Story points the create screen had no story point field for (D55). */
  storyPoints?: number | null;
};

export type CreatePlan = {
  request: JiraWrite;
  /** Epic to link after creation when Jira does not accept it on the create screen. */
  epicAfterCreate: string | null;
  dropped: DroppedFields;
  /** What making the description safe changed (D51). */
  safety: Pick<WikiSafety, "images" | "mentions">;
};

/**
 * "The Task create screen in OPS has no Labels or Assignee field, so ..." (D44),
 * or null when nothing was dropped.
 */
export function droppedFieldsWarning(
  d: DroppedFields,
  issueType: string,
  projectKey: string,
): string | null {
  const parts: [string, string][] = [];
  if (d.labels.length) parts.push(["Labels", `the label ${d.labels.join(", ")} was not set`]);
  if (d.assignee) parts.push(["Assignee", `it was not assigned to ${d.assignee}`]);
  if (d.description) parts.push(["Description", "the description (with who asked) was not sent"]);
  if (typeof d.storyPoints === "number")
    parts.push(["Story Points", `it was created without its ${pointsLabel(d.storyPoints)}`]);
  if (!parts.length) return null;
  const names = parts.map(([n]) => n);
  const fields =
    names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
  return `The ${issueType} create screen in ${projectKey} has no ${fields} field, so ${parts
    .map(([, what]) => what)
    .join(" and ")}.`;
}

/**
 * A create's Markdown description as wiki markup. The provenance block's quote
 * is pasted text (untrusted), so it goes to Jira as a literal `{noformat}` block:
 * it cannot embed remote images, mention users or run macros (D44). The "Asked
 * by" line is escaped, since the requester's name may come from a sender. The
 * model's part before it keeps only balanced `{code}` / `{noformat}` blocks, so
 * a marker it leaves open cannot pair with the quote's opener and turn the line
 * literal and the quote live (D51).
 */
export function descriptionToWiki(descriptionMd: string): string {
  const block = splitProvenance(descriptionMd);
  if (!block) return markdownToWiki(descriptionMd);
  return [
    block.base && balanceBlockMarkers(markdownToWiki(block.base)),
    provenanceLineWiki(block.line),
    block.quote && literalWiki(block.quote),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The one conversion of proposal text (a create's description, a comment's body)
 * to wiki markup: Markdown converted, a small ask's quote kept literal (D44), then
 * remote images turned into links and unknown mentions into text (D51). Text the
 * user types in the ticket view does not come through here.
 */
export function proposalTextToWiki(
  markdown: string,
  knownUsers: readonly (string | null)[],
): WikiSafety {
  return sanitiseProposalWiki(descriptionToWiki(markdown), knownUsers);
}

// Fields Jira fills itself or that the app always sends.
const IMPLICIT_FIELDS = new Set(["project", "issuetype", "summary", "reporter"]);

export function buildCreateIssue(input: CreateIssueInput, ctx: CreateContext): CreatePlan {
  const allowed = new Set(ctx.fields.map((f) => f.fieldId));
  const fields: Record<string, unknown> = {
    project: { key: input.projectKey },
    issuetype: { id: input.issueTypeId },
    summary: input.summary,
  };
  /** Sets a field the create screen has; false when it has none, so the value is dropped. */
  const set = (fieldId: string, value: unknown) => {
    if (!allowed.has(fieldId)) return false;
    fields[fieldId] = value;
    return true;
  };
  const dropped: DroppedFields = { labels: [], assignee: null, description: false };
  const safety: CreatePlan["safety"] = { images: [], mentions: [] };
  if (input.descriptionMd) {
    const safe = proposalTextToWiki(input.descriptionMd, ctx.knownUsers ?? []);
    dropped.description = !set("description", safe.wiki);
    if (!dropped.description)
      Object.assign(safety, { images: safe.images, mentions: safe.mentions });
  }
  if (input.priority) set("priority", { name: input.priority });
  if (
    input.assignee &&
    !set("assignee", ctx.deployment === "cloud" ? { id: input.assignee } : { name: input.assignee })
  )
    dropped.assignee = input.assignee;
  if (input.dueDate) set("duedate", input.dueDate);
  const labels = [...new Set(input.labels ?? [])];
  if (labels.length && !set("labels", labels)) dropped.labels = labels;
  // An Epic never gets points (D55); otherwise the first story point field on the screen.
  if (typeof input.storyPoints === "number" && !/^epic$/i.test(input.issueTypeName)) {
    const field = pointsFieldOn(ctx.fieldIds, allowed);
    if (field) fields[field] = input.storyPoints;
    else dropped.storyPoints = input.storyPoints;
  }

  const isSubtask = input.subtask ?? /sub-?task/i.test(input.issueTypeName);
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
  return {
    request: { method: "POST", path: "issue", body: { fields } },
    epicAfterCreate,
    dropped,
    safety,
  };
}

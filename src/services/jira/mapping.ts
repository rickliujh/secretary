/**
 * Pure mapping from Jira issue JSON to cache rows (design.md section 4).
 */
import { z } from "zod";
import type { jiraComments, jiraIssues } from "@/db/schema";
import { datePart, type SprintInfo } from "@/services/sprints/calendar";
import { jiraDateToIso, jiraDateToIsoOrNull } from "./dates";
import type { FieldIds } from "./fields";
import {
  CommentSchema,
  IssueTypeSchema,
  NamedSchema,
  ParentSchema,
  ProjectRefSchema,
  type RawIssue,
  StatusSchema,
  UserRefSchema,
} from "./schemas";

export type IssueRow = typeof jiraIssues.$inferInsert;
export type CommentRow = typeof jiraComments.$inferInsert;

export type MappedIssue = {
  issue: IssueRow;
  comments: CommentRow[];
  /** False when Jira embedded fewer comments than the issue has. */
  commentsComplete: boolean;
  /** Sprints on the issue with their boards and dates, for the sprint calendar (D23). */
  sprints: SprintInfo[];
};

export type MapContext = {
  fieldIds: FieldIds;
  trackedEpics: ReadonlySet<string>;
  syncedAt: string;
};

/** Fields requested from search and GET /issue. */
export function issueFields(fieldIds: FieldIds): string[] {
  return [
    "summary",
    "description",
    "issuetype",
    "project",
    "status",
    "priority",
    "assignee",
    "reporter",
    "parent",
    "labels",
    "components",
    "duedate",
    "created",
    "updated",
    "resolutiondate",
    "issuelinks",
    "attachment",
    "comment",
    ...[fieldIds.epicLink, fieldIds.epicName, fieldIds.sprint].filter((f): f is string => !!f),
  ];
}

const parse = <T>(schema: z.ZodType<T>, value: unknown): T | undefined => {
  const r = schema.safeParse(value);
  return r.success ? r.data : undefined;
};

const STATUS_CATEGORIES = new Set(["new", "indeterminate", "done"]);

const legacy = (item: string, key: string) => {
  const v = new RegExp(`[[,]${key}=([^,\\]]*)`).exec(item)?.[1];
  return v && v !== "<null>" ? v : null;
};
const num = (v: unknown) => (typeof v === "number" ? v : v ? Number(v) || null : null);

/**
 * Parses the Sprint field: Data Center's legacy `Sprint@...[id=..,name=..]`
 * strings, or objects (Cloud, newer Data Center).
 */
export function parseSprints(value: unknown): SprintInfo[] {
  if (!Array.isArray(value)) return [];
  const out: SprintInfo[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const name = legacy(item, "name");
      if (name)
        out.push({
          id: num(legacy(item, "id")) ?? 0,
          name,
          state: (legacy(item, "state") ?? "").toLowerCase(),
          boardId: num(legacy(item, "rapidViewId")),
          start: datePart(legacy(item, "startDate")),
          end: datePart(legacy(item, "endDate")),
        });
    } else if (item && typeof item === "object" && "name" in item) {
      const o = item as Record<string, unknown>;
      if (typeof o.name === "string")
        out.push({
          id: num(o.id) ?? 0,
          name: o.name,
          state: String(o.state ?? "").toLowerCase(),
          boardId: num(o.boardId ?? o.originBoardId ?? o.rapidViewId),
          start: datePart(typeof o.startDate === "string" ? o.startDate : null),
          end: datePart(typeof o.endDate === "string" ? o.endDate : null),
        });
    }
  }
  return out;
}

/** Active sprint first, then the next future one, then the most recent. */
export function currentSprint(value: unknown): string | null {
  const sprints = parseSprints(value);
  return (
    sprints.find((s) => s.state === "active")?.name ??
    sprints.find((s) => s.state === "future")?.name ??
    sprints.at(-1)?.name ??
    null
  );
}

const CommentBlockSchema = z.object({ comments: z.array(z.unknown()), total: z.number() });
const RenderedCommentsSchema = z.object({
  comments: z.array(z.object({ id: z.string(), body: z.string().nullish() })),
});

export function mapComment(
  issueKey: string,
  raw: unknown,
  renderedBody?: string | null,
): CommentRow | undefined {
  const c = parse(CommentSchema, raw);
  if (!c) return undefined;
  return {
    id: c.id,
    issueKey,
    author: c.author?.id ?? null,
    authorDisplay: c.author?.displayName ?? null,
    body: c.body,
    bodyHtml: renderedBody ?? c.renderedBody ?? null,
    created: jiraDateToIso(c.created),
    updated: jiraDateToIso(c.updated),
  };
}

export function mapIssue(raw: RawIssue, ctx: MapContext): MappedIssue {
  const f = raw.fields;
  const rendered = raw.renderedFields ?? {};
  const issuetype = parse(IssueTypeSchema, f.issuetype) ?? { name: "Unknown", subtask: false };
  const status = parse(StatusSchema, f.status);
  const project = parse(ProjectRefSchema, f.project);
  const parent = parse(ParentSchema, f.parent);
  const assignee = parse(UserRefSchema, f.assignee);
  const reporter = parse(UserRefSchema, f.reporter);
  const epicLink = ctx.fieldIds.epicLink ? f[ctx.fieldIds.epicLink] : undefined;
  // Cloud links stories to epics through `parent`; hierarchyLevel 1 marks an epic.
  const parentIsEpic =
    parent?.fields?.issuetype?.hierarchyLevel === 1 || parent?.fields?.issuetype?.name === "Epic";
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const names = (v: unknown) =>
    Array.isArray(v)
      ? v.map((x) => parse(NamedSchema, x)?.name).filter((x): x is string => !!x)
      : [];

  const { comment, ...rest } = f;
  const block = parse(CommentBlockSchema, comment);
  const renderedComments = parse(
    RenderedCommentsSchema,
    (rendered as Record<string, unknown>).comment,
  );
  const renderedById = new Map(renderedComments?.comments.map((c) => [c.id, c.body]) ?? []);
  const comments = (block?.comments ?? [])
    .map((c) => {
      const id = parse(z.object({ id: z.string() }), c)?.id;
      return mapComment(raw.key, c, id ? renderedById.get(id) : undefined);
    })
    .filter((c): c is CommentRow => !!c);

  const categoryKey = status?.statusCategory.key ?? "new";
  const renderedDescription = (rendered as Record<string, unknown>).description;

  return {
    issue: {
      key: raw.key,
      id: raw.id,
      projectKey: project?.key ?? raw.key.split("-")[0] ?? "",
      issueType: issuetype.name,
      isSubtask: issuetype.subtask || issuetype.hierarchyLevel === -1,
      summary: typeof f.summary === "string" ? f.summary : "",
      description: typeof f.description === "string" ? f.description : null,
      descriptionHtml: typeof renderedDescription === "string" ? renderedDescription : null,
      status: status?.name ?? "Unknown",
      statusCategory: (STATUS_CATEGORIES.has(categoryKey)
        ? categoryKey
        : "new") as IssueRow["statusCategory"],
      priority: parse(NamedSchema, f.priority)?.name ?? null,
      assignee: assignee?.id ?? null,
      assigneeDisplay: assignee?.displayName ?? null,
      reporter: reporter?.id ?? null,
      reporterDisplay: reporter?.displayName ?? null,
      parentKey: parent && !parentIsEpic ? parent.key : null,
      epicKey:
        typeof epicLink === "string" && epicLink
          ? epicLink
          : parentIsEpic
            ? (parent?.key ?? null)
            : null,
      epicName:
        ctx.fieldIds.epicName && typeof f[ctx.fieldIds.epicName] === "string"
          ? (f[ctx.fieldIds.epicName] as string)
          : null,
      labels: strings(f.labels),
      components: names(f.components),
      sprint: ctx.fieldIds.sprint ? currentSprint(f[ctx.fieldIds.sprint]) : null,
      dueDate: typeof f.duedate === "string" ? f.duedate : null,
      created: jiraDateToIso(String(f.created)),
      updated: jiraDateToIso(String(f.updated)),
      resolved: jiraDateToIsoOrNull(f.resolutiondate),
      raw: rest,
      syncedAt: ctx.syncedAt,
      isTrackedEpic: ctx.trackedEpics.has(raw.key),
      stale: false,
    },
    comments,
    commentsComplete: block ? block.total <= comments.length : true,
    sprints: ctx.fieldIds.sprint ? parseSprints(f[ctx.fieldIds.sprint]) : [],
  };
}

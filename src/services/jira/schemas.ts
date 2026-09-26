/**
 * zod schemas for the Jira Data Center REST v2 responses the app uses
 * (design.md section 5). Issue `fields` stay an open record so custom fields
 * survive; typed field schemas are applied during mapping.
 */
import { z } from "zod";

/**
 * A Jira user. Data Center identifies users by `name` (username); Cloud has no
 * `name` and uses `accountId` (design.md D19). `id` is whichever applies, and is
 * what the app stores as "the Jira user" (assignee, reporter, contacts).
 */
const UserFieldsSchema = z.object({
  name: z.string().optional(),
  accountId: z.string().optional(),
  key: z.string().optional(),
  displayName: z.string(),
  emailAddress: z.string().optional(),
  active: z.boolean().optional(),
});

const withUserId = <S extends z.ZodType<z.infer<typeof UserFieldsSchema>>>(schema: S) =>
  schema
    .transform((u: z.output<S>) => ({ ...u, id: u.accountId ?? u.name ?? "" }))
    .refine((u) => u.id !== "", "User has neither accountId nor name");

export const UserRefSchema = withUserId(UserFieldsSchema);
export type UserRef = z.infer<typeof UserRefSchema>;

/** `GET /rest/api/2/myself`: a user plus their Jira time zone. */
export const JiraUserSchema = withUserId(
  UserFieldsSchema.extend({ timeZone: z.string().optional() }),
);
export type JiraUser = z.infer<typeof JiraUserSchema>;

export const StatusSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  statusCategory: z.object({ key: z.string(), name: z.string().optional() }),
});

export const NamedSchema = z.object({ id: z.string().optional(), name: z.string() });

export const IssueTypeSchema = z.object({
  id: z.string().optional(),
  name: z.string(),
  subtask: z.boolean().default(false),
  /** Cloud: -1 sub-task, 0 standard, 1 epic (2+ on Premium hierarchies). */
  hierarchyLevel: z.number().optional(),
});

export const ProjectRefSchema = z.object({
  id: z.string().optional(),
  key: z.string(),
  name: z.string().optional(),
});

export const ParentSchema = z.object({
  id: z.string().optional(),
  key: z.string(),
  fields: z
    .object({ summary: z.string().optional(), issuetype: IssueTypeSchema.optional() })
    .optional(),
});

export const CommentSchema = z.object({
  id: z.string(),
  author: UserRefSchema.optional(),
  body: z.string().default(""),
  renderedBody: z.string().optional(),
  created: z.string(),
  updated: z.string(),
});
export type JiraComment = z.infer<typeof CommentSchema>;

export const CommentPageSchema = z.object({
  startAt: z.number(),
  maxResults: z.number(),
  total: z.number(),
  comments: z.array(CommentSchema),
});
export type CommentPage = z.infer<typeof CommentPageSchema>;

const LinkedIssueSchema = z.object({
  id: z.string().optional(),
  key: z.string(),
  fields: z
    .object({
      summary: z.string().optional(),
      status: StatusSchema.optional(),
      issuetype: IssueTypeSchema.optional(),
    })
    .optional(),
});

export const IssueLinkSchema = z.object({
  id: z.string(),
  type: z.object({
    id: z.string().optional(),
    name: z.string(),
    inward: z.string(),
    outward: z.string(),
  }),
  inwardIssue: LinkedIssueSchema.optional(),
  outwardIssue: LinkedIssueSchema.optional(),
});
export type IssueLink = z.infer<typeof IssueLinkSchema>;

export const AttachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  size: z.number().optional(),
  mimeType: z.string().optional(),
  content: z.string().optional(),
  created: z.string().optional(),
  author: UserRefSchema.optional(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

/** One issue as returned by search or GET /issue. */
export const RawIssueSchema = z.object({
  id: z.string(),
  key: z.string(),
  fields: z.record(z.string(), z.unknown()),
  renderedFields: z.record(z.string(), z.unknown()).nullish(),
});
export type RawIssue = z.infer<typeof RawIssueSchema>;

/** Data Center `POST /search`: offset paging with a total. */
export const SearchPageSchema = z.object({
  startAt: z.number(),
  maxResults: z.number(),
  total: z.number(),
  issues: z.array(RawIssueSchema),
});
export type SearchPage = z.infer<typeof SearchPageSchema>;

/** Cloud `POST /search/jql`: token paging, no total (the old /search returns 410). */
export const CloudSearchPageSchema = z.object({
  issues: z.array(RawIssueSchema),
  nextPageToken: z.string().nullish(),
  isLast: z.boolean().optional(),
});

export const FieldSchema = z.object({
  id: z.string(),
  name: z.string(),
  custom: z.boolean().default(false),
  schema: z
    .object({
      type: z.string().optional(),
      items: z.string().optional(),
      custom: z.string().optional(),
      customId: z.number().optional(),
    })
    .optional(),
});
export type JiraField = z.infer<typeof FieldSchema>;

export const TransitionsSchema = z.object({
  transitions: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      to: z.object({ name: z.string(), statusCategory: z.object({ key: z.string() }).optional() }),
    }),
  ),
});
export type Transition = z.infer<typeof TransitionsSchema>["transitions"][number];

export const PrioritySchema = z.object({ id: z.string(), name: z.string() });
export type Priority = z.infer<typeof PrioritySchema>;

/** Cloud `GET /priority/search` (plain `/priority` is deprecated there). */
export const PrioritySearchSchema = z.object({
  values: z.array(PrioritySchema),
  isLast: z.boolean().optional(),
});

export const ProjectSchema = z.object({ id: z.string(), key: z.string(), name: z.string() });
export type Project = z.infer<typeof ProjectSchema>;

const FieldMetaSchema = z.object({
  name: z.string(),
  required: z.boolean().default(false),
  hasDefaultValue: z.boolean().optional(),
  schema: z.object({ type: z.string().optional(), custom: z.string().optional() }).optional(),
  operations: z.array(z.string()).optional(),
  allowedValues: z.array(z.unknown()).optional(),
});

export const EditMetaSchema = z.object({ fields: z.record(z.string(), FieldMetaSchema) });
export type EditMeta = z.infer<typeof EditMetaSchema>;

const CreateMetaIssueTypeSchema = IssueTypeSchema.extend({ id: z.string() });
export type CreateMetaIssueType = z.infer<typeof CreateMetaIssueTypeSchema>;

/**
 * `GET /issue/createmeta/{project}/issuetypes`: Data Center pages in `values`,
 * Cloud in `issueTypes` (alias `createMetaIssueType`).
 */
export const CreateMetaIssueTypesSchema = z
  .object({
    values: z.array(CreateMetaIssueTypeSchema).optional(),
    issueTypes: z.array(CreateMetaIssueTypeSchema).optional(),
    createMetaIssueType: z.array(CreateMetaIssueTypeSchema).optional(),
  })
  .transform((r) => r.values ?? r.issueTypes ?? r.createMetaIssueType ?? []);

const CreateMetaFieldSchema = FieldMetaSchema.extend({ fieldId: z.string() });
export type CreateMetaField = z.infer<typeof CreateMetaFieldSchema>;

/** `GET /issue/createmeta/{project}/issuetypes/{id}`: `values` on Data Center, `fields` (alias `results`) on Cloud. */
export const CreateMetaFieldsSchema = z
  .object({
    values: z.array(CreateMetaFieldSchema).optional(),
    fields: z.array(CreateMetaFieldSchema).optional(),
    results: z.array(CreateMetaFieldSchema).optional(),
  })
  .transform((r) => r.values ?? r.fields ?? r.results ?? []);

export const RemoteLinkSchema = z.object({
  id: z.number(),
  globalId: z.string().optional(),
  object: z.object({ url: z.string(), title: z.string() }),
});
export type RemoteLink = z.infer<typeof RemoteLinkSchema>;

/** `GET /project/{key}/statuses`: every issue type of a project with its statuses (DC and Cloud). */
export const ProjectStatusesSchema = z.array(
  z.object({
    name: z.string(),
    subtask: z.boolean().optional(),
    statuses: z.array(z.object({ name: z.string() })),
  }),
);
export type ProjectStatuses = z.infer<typeof ProjectStatusesSchema>;

/** Agile `GET /rest/agile/1.0/board/{id}/sprint`: one page of a board's sprints (DC and Cloud). */
export const BoardSprintPageSchema = z.object({
  isLast: z.boolean().optional(),
  values: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      state: z.string(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      originBoardId: z.number().optional(),
    }),
  ),
});
export type BoardSprintPage = z.infer<typeof BoardSprintPageSchema>;

export const CreatedIssueSchema = z.object({ id: z.string(), key: z.string() });

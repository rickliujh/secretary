/**
 * zod schemas for the Jira Data Center REST v2 responses the app uses
 * (design.md section 5). Issue `fields` stay an open record so custom fields
 * survive; typed field schemas are applied during mapping.
 */
import { z } from "zod";

export const UserRefSchema = z.object({
  name: z.string(),
  key: z.string().optional(),
  displayName: z.string(),
  emailAddress: z.string().optional(),
  active: z.boolean().optional(),
});
export type UserRef = z.infer<typeof UserRefSchema>;

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

export const SearchPageSchema = z.object({
  startAt: z.number(),
  maxResults: z.number(),
  total: z.number(),
  issues: z.array(RawIssueSchema),
});
export type SearchPage = z.infer<typeof SearchPageSchema>;

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

/** `GET /issue/createmeta/{project}/issuetypes` (DC 8.4+). */
export const CreateMetaIssueTypesSchema = z.object({
  values: z.array(IssueTypeSchema.extend({ id: z.string() })),
  isLast: z.boolean().optional(),
});
export type CreateMetaIssueType = z.infer<typeof CreateMetaIssueTypesSchema>["values"][number];

/** `GET /issue/createmeta/{project}/issuetypes/{id}` (DC 8.4+). */
export const CreateMetaFieldsSchema = z.object({
  values: z.array(FieldMetaSchema.extend({ fieldId: z.string() })),
  isLast: z.boolean().optional(),
});
export type CreateMetaField = z.infer<typeof CreateMetaFieldsSchema>["values"][number];

export const IssueLinkTypesSchema = z.object({
  issueLinkTypes: z.array(
    z.object({ id: z.string(), name: z.string(), inward: z.string(), outward: z.string() }),
  ),
});

export const RemoteLinkSchema = z.object({
  id: z.number(),
  globalId: z.string().optional(),
  object: z.object({ url: z.string(), title: z.string() }),
});
export type RemoteLink = z.infer<typeof RemoteLinkSchema>;

export const CreatedIssueSchema = z.object({ id: z.string(), key: z.string() });

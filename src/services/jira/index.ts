import { Context, Data, type Effect } from "effect";
import { z } from "zod";
import type {
  CommentPage,
  CreateMetaField,
  CreateMetaIssueType,
  EditMeta,
  JiraField,
  Priority,
  Project,
  RawIssue,
  RemoteLink,
  Transition,
  UserRef,
} from "./schemas";

export * from "./schemas";

export type JiraErrorKind = "not_configured" | "auth" | "http" | "network" | "timeout" | "decode";

export class JiraError extends Data.TaggedError("JiraError")<{
  readonly kind: JiraErrorKind;
  readonly message: string;
  readonly status?: number;
}> {}

/** `GET /rest/api/2/myself`; `id` is the account ID on Cloud and the username on Data Center. */
export const JiraUserSchema = z
  .object({
    name: z.string().optional(),
    accountId: z.string().optional(),
    key: z.string().optional(),
    displayName: z.string(),
    emailAddress: z.string().optional(),
    active: z.boolean().optional(),
    timeZone: z.string().optional(),
  })
  .transform((u) => ({ ...u, id: u.accountId ?? u.name ?? "" }))
  .refine((u) => u.id !== "", "User has neither accountId nor name");
export type JiraUser = z.infer<typeof JiraUserSchema>;

export type { Credentials } from "@/services/atlassian/credentials";

import type { Credentials } from "@/services/atlassian/credentials";
import type { Deployment } from "@/services/atlassian/deployment";

export type SearchRequest = {
  jql: string;
  /** Null for the first page, then the `next` of the previous result. */
  cursor: string | null;
  maxResults: number;
  fields: readonly string[];
  expand?: readonly string[];
};

/** One page of search results; `next` is null on the last page. `total` is unknown on Cloud. */
export type SearchResult = { issues: RawIssue[]; next: string | null; total: number | null };

/** A write request built by `executor/jira-mapping.ts`. */
export type JiraWrite = {
  method: "POST" | "PUT" | "DELETE";
  /** Path under `/rest/api/2/`, without a leading slash. */
  path: string;
  body?: unknown;
};

export interface JiraClientShape {
  /**
   * Calls `/myself`. Values passed in override stored ones so the settings form
   * can test before saving.
   */
  readonly testConnection: (overrides?: Credentials) => Effect.Effect<JiraUser, JiraError>;
  readonly myself: Effect.Effect<JiraUser, JiraError>;
  /** API root (the site root on Cloud), for building browse links. */
  readonly baseUrl: Effect.Effect<string, JiraError>;
  readonly deployment: Effect.Effect<Deployment, JiraError>;
  readonly fields: Effect.Effect<readonly JiraField[], JiraError>;
  readonly search: (req: SearchRequest) => Effect.Effect<SearchResult, JiraError>;
  readonly getIssue: (
    key: string,
    opts: { fields: readonly string[]; expand?: readonly string[] },
  ) => Effect.Effect<RawIssue, JiraError>;
  readonly getComments: (key: string, startAt: number) => Effect.Effect<CommentPage, JiraError>;
  readonly getTransitions: (key: string) => Effect.Effect<readonly Transition[], JiraError>;
  readonly getEditMeta: (key: string) => Effect.Effect<EditMeta, JiraError>;
  readonly priorities: Effect.Effect<readonly Priority[], JiraError>;
  readonly projects: Effect.Effect<readonly Project[], JiraError>;
  readonly assignableUsers: (
    issueKey: string,
    query: string,
  ) => Effect.Effect<readonly UserRef[], JiraError>;
  readonly createMetaIssueTypes: (
    projectKey: string,
  ) => Effect.Effect<readonly CreateMetaIssueType[], JiraError>;
  readonly createMetaFields: (
    projectKey: string,
    issueTypeId: string,
  ) => Effect.Effect<readonly CreateMetaField[], JiraError>;
  readonly remoteLinks: (key: string) => Effect.Effect<readonly RemoteLink[], JiraError>;
  /**
   * Raw write. Only `Executor` may call this (CLAUDE.md hard rule): every
   * Jira write is an approved proposal or an explicit user action.
   */
  readonly send: (req: JiraWrite) => Effect.Effect<unknown, JiraError>;
}

export class JiraClient extends Context.Tag("JiraClient")<JiraClient, JiraClientShape>() {}

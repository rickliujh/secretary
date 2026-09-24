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
  SearchPage,
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

/** `GET /rest/api/2/myself` on Data Center. */
export const JiraUserSchema = z.object({
  name: z.string(),
  key: z.string().optional(),
  displayName: z.string(),
  emailAddress: z.string().optional(),
  active: z.boolean().optional(),
  timeZone: z.string().optional(),
});
export type JiraUser = z.infer<typeof JiraUserSchema>;

export type Credentials = { baseUrl?: string; pat?: string };

export type SearchRequest = {
  jql: string;
  startAt: number;
  maxResults: number;
  fields: readonly string[];
  expand?: readonly string[];
};

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
  /** Base URL from settings, for building browse links. */
  readonly baseUrl: Effect.Effect<string, JiraError>;
  readonly fields: Effect.Effect<readonly JiraField[], JiraError>;
  readonly search: (req: SearchRequest) => Effect.Effect<SearchPage, JiraError>;
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

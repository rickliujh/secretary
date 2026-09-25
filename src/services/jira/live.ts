import { Effect, Layer } from "effect";
import type { KyInstance } from "ky";
import { z } from "zod";
import { resolveCredentials } from "@/services/atlassian/credentials";
import { Fetcher } from "@/services/http";
import { HttpFailure, makeAtlassianClient, requestJson } from "@/services/http/json";
import { Secrets } from "@/services/secrets";
import { Settings } from "@/services/settings";
import {
  CloudSearchPageSchema,
  CommentPageSchema,
  CreateMetaFieldsSchema,
  CreateMetaIssueTypesSchema,
  type Credentials,
  EditMetaSchema,
  FieldSchema,
  JiraClient,
  JiraError,
  JiraUserSchema,
  PrioritySchema,
  PrioritySearchSchema,
  ProjectSchema,
  ProjectStatusesSchema,
  RawIssueSchema,
  RemoteLinkSchema,
  SearchPageSchema,
  type SearchResult,
  TransitionsSchema,
  UserRefSchema,
} from ".";

const toJiraError = (e: unknown) =>
  e instanceof HttpFailure
    ? new JiraError({ kind: e.kind, message: e.message, status: e.status })
    : new JiraError({ kind: "network", message: e instanceof Error ? e.message : String(e) });

const notConfigured = (message: string) => new JiraError({ kind: "not_configured", message });

const make = Effect.gen(function* () {
  const settings = yield* Settings;
  const secrets = yield* Secrets;
  const { fetch } = yield* Fetcher;

  const credentials = (overrides?: Credentials) =>
    resolveCredentials("jira", overrides).pipe(
      Effect.provideService(Settings, settings),
      Effect.provideService(Secrets, secrets),
      Effect.mapError((e) => notConfigured(e.message)),
    );

  const client = (overrides?: Credentials) =>
    Effect.map(credentials(overrides), ({ apiBase, auth }) =>
      makeAtlassianClient({ baseUrl: apiBase, apiPrefix: "/rest/api/2", auth, fetch }),
    );

  const call = <T>(
    schema: z.ZodType<T>,
    path: string,
    options?: Parameters<KyInstance>[1],
    overrides?: Credentials,
  ) =>
    Effect.flatMap(client(overrides), (http) =>
      Effect.tryPromise({
        try: (signal) => requestJson(http, path, schema, { ...options, signal }),
        catch: toJiraError,
      }),
    );

  const csv = (values: readonly string[]) => values.join(",");
  const deployment = Effect.map(credentials(), (c) => c.deployment);

  return JiraClient.of({
    testConnection: (overrides) => call(JiraUserSchema, "myself", undefined, overrides),
    myself: call(JiraUserSchema, "myself"),
    baseUrl: Effect.map(credentials(), (c) => c.apiBase),
    deployment,
    fields: call(z.array(FieldSchema), "field"),
    search: (req) =>
      Effect.flatMap(deployment, (d): Effect.Effect<SearchResult, JiraError> => {
        // Search only reads, so retrying a rate-limited POST is safe.
        const retry = { limit: 3, methods: ["post" as const], statusCodes: [429, 503] };
        if (d === "cloud") {
          return call(CloudSearchPageSchema, "search/jql", {
            method: "post",
            retry,
            json: {
              jql: req.jql,
              ...(req.cursor ? { nextPageToken: req.cursor } : {}),
              maxResults: req.maxResults,
              fields: req.fields,
              expand: (req.expand ?? []).join(","),
            },
          }).pipe(
            Effect.map((r) => ({
              issues: r.issues,
              next: r.isLast || !r.nextPageToken ? null : r.nextPageToken,
              total: null,
            })),
          );
        }
        const startAt = req.cursor ? Number(req.cursor) : 0;
        return call(SearchPageSchema, "search", {
          method: "post",
          retry,
          json: {
            jql: req.jql,
            startAt,
            maxResults: req.maxResults,
            fields: req.fields,
            expand: req.expand ?? [],
            // "warn" so a mistyped tracked-epic key does not fail the whole sync.
            validateQuery: "warn",
          },
        }).pipe(
          Effect.map((r) => {
            const nextStart = startAt + r.issues.length;
            return {
              issues: r.issues,
              next: r.issues.length && nextStart < r.total ? String(nextStart) : null,
              total: r.total,
            };
          }),
        );
      }),
    getIssue: (key, opts) =>
      call(RawIssueSchema, `issue/${encodeURIComponent(key)}`, {
        searchParams: { fields: csv(opts.fields), expand: csv(opts.expand ?? []) },
      }),
    getComments: (key, startAt) =>
      call(CommentPageSchema, `issue/${encodeURIComponent(key)}/comment`, {
        searchParams: { startAt, maxResults: 100, expand: "renderedBody" },
      }),
    getTransitions: (key) =>
      call(TransitionsSchema, `issue/${encodeURIComponent(key)}/transitions`).pipe(
        Effect.map((r) => r.transitions),
      ),
    getEditMeta: (key) => call(EditMetaSchema, `issue/${encodeURIComponent(key)}/editmeta`),
    priorities: Effect.flatMap(deployment, (d) =>
      d === "cloud"
        ? call(PrioritySearchSchema, "priority/search", { searchParams: { maxResults: 100 } }).pipe(
            Effect.map((r) => r.values),
          )
        : call(z.array(PrioritySchema), "priority"),
    ),
    projects: call(z.array(ProjectSchema), "project"),
    assignableUsers: (issueKey, text) =>
      Effect.flatMap(deployment, (d) =>
        call(z.array(UserRefSchema), "user/assignable/search", {
          // Cloud dropped `username` for `query`.
          searchParams: { issueKey, [d === "cloud" ? "query" : "username"]: text, maxResults: 20 },
        }),
      ),
    createMetaIssueTypes: (projectKey) =>
      call(
        CreateMetaIssueTypesSchema,
        `issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes`,
        {
          searchParams: { maxResults: 100 },
        },
      ),
    createMetaFields: (projectKey, issueTypeId) =>
      call(
        CreateMetaFieldsSchema,
        `issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${encodeURIComponent(issueTypeId)}`,
        { searchParams: { maxResults: 200 } },
      ),
    projectStatuses: (projectKey) =>
      call(ProjectStatusesSchema, `project/${encodeURIComponent(projectKey)}/statuses`),
    remoteLinks: (key) =>
      call(z.array(RemoteLinkSchema), `issue/${encodeURIComponent(key)}/remotelink`),
    send: (req) =>
      call(z.unknown(), req.path, {
        method: req.method.toLowerCase() as "post" | "put" | "delete",
        ...(req.body === undefined ? {} : { json: req.body }),
        // Writes are not idempotent; never retry them automatically.
        retry: 0,
      }),
  });
});

export const JiraClientLive = Layer.effect(JiraClient, make);

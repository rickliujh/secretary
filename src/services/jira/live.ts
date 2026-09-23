import { Effect, Layer, Option } from "effect";
import type { KyInstance } from "ky";
import { z } from "zod";
import { Fetcher } from "@/services/http";
import { HttpFailure, makeBearerClient, normalizeBaseUrl, requestJson } from "@/services/http/json";
import { Secrets, secretNames } from "@/services/secrets";
import { Settings } from "@/services/settings";
import {
  CommentPageSchema,
  CreateMetaFieldsSchema,
  type Credentials,
  EditMetaSchema,
  FieldSchema,
  JiraClient,
  JiraError,
  JiraUserSchema,
  PrioritySchema,
  ProjectSchema,
  RawIssueSchema,
  RemoteLinkSchema,
  SearchPageSchema,
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

  const credentials = (overrides: Credentials = {}) =>
    Effect.gen(function* () {
      const stored = yield* settings.get.pipe(Effect.mapError((e) => notConfigured(e.message)));
      const baseUrl = overrides.baseUrl?.trim() || stored.jira.baseUrl;
      const pat =
        overrides.pat?.trim() ||
        Option.getOrUndefined(
          yield* secrets
            .get(secretNames.jiraPat)
            .pipe(Effect.mapError((e) => notConfigured(e.message))),
        );
      if (!baseUrl) return yield* notConfigured("Set the Jira base URL in Settings.");
      if (!pat) return yield* notConfigured("Set a Jira personal access token in Settings.");
      return { baseUrl: normalizeBaseUrl(baseUrl), pat };
    });

  const client = (overrides?: Credentials) =>
    Effect.map(credentials(overrides), ({ baseUrl, pat }) =>
      makeBearerClient({ baseUrl, apiPrefix: "/rest/api/2", token: pat, fetch }),
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

  return JiraClient.of({
    testConnection: (overrides) => call(JiraUserSchema, "myself", undefined, overrides),
    myself: call(JiraUserSchema, "myself"),
    baseUrl: Effect.map(credentials(), (c) => c.baseUrl),
    fields: call(z.array(FieldSchema), "field"),
    search: (req) =>
      call(SearchPageSchema, "search", {
        method: "post",
        json: {
          jql: req.jql,
          startAt: req.startAt,
          maxResults: req.maxResults,
          fields: req.fields,
          expand: req.expand ?? [],
          // "warn" so a mistyped tracked-epic key does not fail the whole sync.
          validateQuery: "warn",
        },
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
    priorities: call(z.array(PrioritySchema), "priority"),
    projects: call(z.array(ProjectSchema), "project"),
    assignableUsers: (issueKey, query) =>
      call(z.array(UserRefSchema), "user/assignable/search", {
        searchParams: { issueKey, username: query, maxResults: 20 },
      }),
    createMetaFields: (projectKey, issueTypeId) =>
      call(
        CreateMetaFieldsSchema,
        `issue/createmeta/${encodeURIComponent(projectKey)}/issuetypes/${encodeURIComponent(issueTypeId)}`,
        { searchParams: { maxResults: 200 } },
      ).pipe(Effect.map((r) => r.values)),
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

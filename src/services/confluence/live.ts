import { Effect, Layer } from "effect";
import type { KyInstance } from "ky";
import type { z } from "zod";
import { resolveCredentials } from "@/services/atlassian/credentials";
import { Fetcher } from "@/services/http";
import { HttpFailure, makeAtlassianClient, requestJson } from "@/services/http/json";
import { Secrets } from "@/services/secrets";
import { Settings } from "@/services/settings";
import {
  ConfluenceClient,
  ConfluenceError,
  ConfluenceUserSchema,
  type Credentials,
  PageSchema,
  SearchResultSchema,
} from ".";

const toConfluenceError = (e: unknown) =>
  e instanceof HttpFailure
    ? new ConfluenceError({ kind: e.kind, message: e.message, status: e.status })
    : new ConfluenceError({ kind: "network", message: e instanceof Error ? e.message : String(e) });

const notConfigured = (message: string) => new ConfluenceError({ kind: "not_configured", message });

const make = Effect.gen(function* () {
  const settings = yield* Settings;
  const secrets = yield* Secrets;
  const { fetch } = yield* Fetcher;

  const credentials = (overrides?: Credentials) =>
    resolveCredentials("confluence", overrides).pipe(
      Effect.provideService(Settings, settings),
      Effect.provideService(Secrets, secrets),
      Effect.mapError((e) => notConfigured(e.message)),
    );

  const call = <T>(
    schema: z.ZodType<T>,
    path: string,
    options?: Parameters<KyInstance>[1],
    overrides?: Credentials,
  ) =>
    Effect.flatMap(credentials(overrides), ({ apiBase, auth }) =>
      Effect.tryPromise({
        try: (signal) =>
          requestJson(
            makeAtlassianClient({ baseUrl: apiBase, apiPrefix: "/rest/api", auth, fetch }),
            path,
            schema,
            {
              ...options,
              signal,
            },
          ),
        catch: toConfluenceError,
      }),
    );

  return ConfluenceClient.of({
    testConnection: (overrides) =>
      call(ConfluenceUserSchema, "user/current", undefined, overrides).pipe(
        Effect.filterOrFail(
          (user) => user.type !== "anonymous",
          () =>
            new ConfluenceError({
              kind: "auth",
              message: "Confluence treated the request as anonymous. Check the PAT.",
            }),
        ),
      ),
    baseUrl: Effect.map(credentials(), (c) => c.apiBase),
    search: (cql, opts = {}) =>
      call(SearchResultSchema, "content/search", {
        searchParams: {
          cql,
          limit: opts.limit ?? 25,
          start: opts.start ?? 0,
          expand: "space,version",
        },
      }),
    getPage: (id) =>
      call(PageSchema, `content/${encodeURIComponent(id)}`, {
        searchParams: { expand: "body.storage,version,space,ancestors" },
      }),
  });
});

export const ConfluenceClientLive = Layer.effect(ConfluenceClient, make);

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
  type Page,
  PageSchema,
  SearchResultSchema,
  V2PageSchema,
  V2SpaceSchema,
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

  /** `prefix` is "/rest/api" (v1, both deployments) or "/api/v2" (Cloud only). */
  const call = <T>(
    schema: z.ZodType<T>,
    path: string,
    options?: Parameters<KyInstance>[1],
    overrides?: Credentials,
    prefix = "/rest/api",
  ) =>
    Effect.flatMap(credentials(overrides), ({ apiBase, auth }) =>
      Effect.tryPromise({
        try: (signal) =>
          requestJson(
            makeAtlassianClient({ baseUrl: apiBase, apiPrefix: prefix, auth, fetch }),
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

  /** Cloud: v2 page plus a space lookup, mapped to the v1 page shape the importer uses. */
  const getCloudPage = (id: string, apiBase: string) =>
    Effect.gen(function* () {
      const page = yield* call(
        V2PageSchema,
        `pages/${encodeURIComponent(id)}`,
        { searchParams: { "body-format": "storage" } },
        undefined,
        "/api/v2",
      );
      const space = yield* call(
        V2SpaceSchema,
        `spaces/${encodeURIComponent(page.spaceId)}`,
        undefined,
        undefined,
        "/api/v2",
      ).pipe(
        Effect.map((sp): { key: string; name?: string } | undefined => sp),
        // The page is still usable without its space name.
        Effect.orElseSucceed(() => undefined),
      );
      return {
        id: page.id,
        type: "page",
        title: page.title,
        space,
        version: { number: page.version.number, when: page.version.createdAt },
        ancestors: [],
        body: { storage: { value: page.body.storage.value } },
        _links: { webui: page._links.webui, base: page._links.base ?? apiBase },
      } satisfies Page;
    });

  return ConfluenceClient.of({
    testConnection: (overrides) =>
      call(ConfluenceUserSchema, "user/current", undefined, overrides).pipe(
        Effect.filterOrFail(
          (user) => user.type !== "anonymous",
          () =>
            new ConfluenceError({
              kind: "auth",
              message: "Confluence treated the request as anonymous. Check the email and token.",
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
      Effect.flatMap(credentials(), ({ deployment, apiBase }) =>
        deployment === "cloud"
          ? getCloudPage(id, apiBase)
          : call(PageSchema, `content/${encodeURIComponent(id)}`, {
              searchParams: { expand: "body.storage,version,space,ancestors" },
            }),
      ),
  });
});

export const ConfluenceClientLive = Layer.effect(ConfluenceClient, make);

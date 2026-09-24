import { Effect, Layer, Option } from "effect";
import type { KyInstance } from "ky";
import type { z } from "zod";
import { Fetcher } from "@/services/http";
import { HttpFailure, makeBearerClient, normalizeBaseUrl, requestJson } from "@/services/http/json";
import { Secrets, secretNames } from "@/services/secrets";
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

  const credentials = (overrides: Credentials = {}) =>
    Effect.gen(function* () {
      const stored = yield* settings.get.pipe(Effect.mapError((e) => notConfigured(e.message)));
      const baseUrl = overrides.baseUrl?.trim() || stored.confluence.baseUrl;
      const pat =
        overrides.pat?.trim() ||
        Option.getOrUndefined(
          yield* secrets
            .get(secretNames.confluencePat)
            .pipe(Effect.mapError((e) => notConfigured(e.message))),
        );
      if (!baseUrl) return yield* notConfigured("Set the Confluence base URL in Settings.");
      if (!pat) return yield* notConfigured("Set a Confluence personal access token in Settings.");
      return { baseUrl: normalizeBaseUrl(baseUrl), pat };
    });

  const call = <T>(
    schema: z.ZodType<T>,
    path: string,
    options?: Parameters<KyInstance>[1],
    overrides?: Credentials,
  ) =>
    Effect.flatMap(credentials(overrides), ({ baseUrl, pat }) =>
      Effect.tryPromise({
        try: (signal) =>
          requestJson(
            makeBearerClient({ baseUrl, apiPrefix: "/rest/api", token: pat, fetch }),
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
    baseUrl: Effect.map(credentials(), (c) => c.baseUrl),
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

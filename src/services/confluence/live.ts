import { Effect, Layer, Option } from "effect";
import { Fetcher } from "@/services/http";
import { HttpFailure, makeBearerClient, requestJson } from "@/services/http/json";
import { Secrets, secretNames } from "@/services/secrets";
import { Settings } from "@/services/settings";
import { ConfluenceClient, ConfluenceError, ConfluenceUserSchema, type Credentials } from ".";

const toConfluenceError = (e: unknown) =>
  e instanceof HttpFailure
    ? new ConfluenceError({ kind: e.kind, message: e.message, status: e.status })
    : new ConfluenceError({ kind: "network", message: e instanceof Error ? e.message : String(e) });

const make = Effect.gen(function* () {
  const settings = yield* Settings;
  const secrets = yield* Secrets;
  const { fetch } = yield* Fetcher;

  const client = (overrides: Credentials = {}) =>
    Effect.gen(function* () {
      const stored = yield* settings.get.pipe(
        Effect.mapError((e) => new ConfluenceError({ kind: "not_configured", message: e.message })),
      );
      const baseUrl = overrides.baseUrl?.trim() || stored.confluence.baseUrl;
      const pat =
        overrides.pat?.trim() ||
        Option.getOrUndefined(
          yield* secrets
            .get(secretNames.confluencePat)
            .pipe(
              Effect.mapError(
                (e) => new ConfluenceError({ kind: "not_configured", message: e.message }),
              ),
            ),
        );
      if (!baseUrl)
        return yield* new ConfluenceError({
          kind: "not_configured",
          message: "Set the Confluence base URL.",
        });
      if (!pat)
        return yield* new ConfluenceError({
          kind: "not_configured",
          message: "Set a Confluence personal access token.",
        });
      return makeBearerClient({ baseUrl, apiPrefix: "/rest/api", token: pat, fetch });
    });

  return ConfluenceClient.of({
    testConnection: (overrides) =>
      Effect.flatMap(client(overrides), (http) =>
        Effect.tryPromise({
          try: () => requestJson(http, "user/current", ConfluenceUserSchema),
          catch: toConfluenceError,
        }),
      ).pipe(
        Effect.filterOrFail(
          (user) => user.type !== "anonymous",
          () =>
            new ConfluenceError({
              kind: "auth",
              message: "Confluence treated the request as anonymous. Check the PAT.",
            }),
        ),
      ),
  });
});

export const ConfluenceClientLive = Layer.effect(ConfluenceClient, make);

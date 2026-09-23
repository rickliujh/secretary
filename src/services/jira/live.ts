import { Effect, Layer, Option } from "effect";
import { Fetcher } from "@/services/http";
import { HttpFailure, makeBearerClient, requestJson } from "@/services/http/json";
import { Secrets, secretNames } from "@/services/secrets";
import { Settings } from "@/services/settings";
import { type Credentials, JiraClient, JiraError, JiraUserSchema } from ".";

const toJiraError = (e: unknown) =>
  e instanceof HttpFailure
    ? new JiraError({ kind: e.kind, message: e.message, status: e.status })
    : new JiraError({ kind: "network", message: e instanceof Error ? e.message : String(e) });

const make = Effect.gen(function* () {
  const settings = yield* Settings;
  const secrets = yield* Secrets;
  const { fetch } = yield* Fetcher;

  const client = (overrides: Credentials = {}) =>
    Effect.gen(function* () {
      const stored = yield* settings.get.pipe(
        Effect.mapError((e) => new JiraError({ kind: "not_configured", message: e.message })),
      );
      const baseUrl = overrides.baseUrl?.trim() || stored.jira.baseUrl;
      const pat =
        overrides.pat?.trim() ||
        Option.getOrUndefined(
          yield* secrets
            .get(secretNames.jiraPat)
            .pipe(
              Effect.mapError((e) => new JiraError({ kind: "not_configured", message: e.message })),
            ),
        );
      if (!baseUrl)
        return yield* new JiraError({ kind: "not_configured", message: "Set the Jira base URL." });
      if (!pat)
        return yield* new JiraError({
          kind: "not_configured",
          message: "Set a Jira personal access token.",
        });
      return makeBearerClient({ baseUrl, apiPrefix: "/rest/api/2", token: pat, fetch });
    });

  return JiraClient.of({
    testConnection: (overrides) =>
      Effect.flatMap(client(overrides), (http) =>
        Effect.tryPromise({
          try: () => requestJson(http, "myself", JiraUserSchema),
          catch: toJiraError,
        }),
      ),
  });
});

export const JiraClientLive = Layer.effect(JiraClient, make);

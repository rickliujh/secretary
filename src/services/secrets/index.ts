import { Context, Data, Effect, type Option } from "effect";

/** Keychain entry names. Values are never stored anywhere else. */
export const secretNames = {
  jiraPat: "jira.pat",
  confluencePat: "confluence.pat",
  providerApiKey: (providerId: string) => `llm.${providerId}.api-key`,
  /** JSON object of extra request headers (design.md D12). */
  providerHeaders: (providerId: string) => `llm.${providerId}.headers`,
} as const;

export class SecretsError extends Data.TaggedError("SecretsError")<{
  readonly message: string;
  readonly name: string;
}> {}

export interface SecretsShape {
  readonly get: (name: string) => Effect.Effect<Option.Option<string>, SecretsError>;
  readonly set: (name: string, value: string) => Effect.Effect<void, SecretsError>;
  readonly remove: (name: string) => Effect.Effect<void, SecretsError>;
}

export class Secrets extends Context.Tag("Secrets")<Secrets, SecretsShape>() {}

/** Reads a JSON-encoded header map; malformed or missing entries yield `{}`. */
export const getHeaders = (providerId: string) =>
  Effect.flatMap(Secrets, (s) => s.get(secretNames.providerHeaders(providerId))).pipe(
    Effect.map((value) => {
      if (value._tag === "None") return {} as Record<string, string>;
      try {
        const parsed: unknown = JSON.parse(value.value);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return Object.fromEntries(
            Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string"),
          );
        }
      } catch {
        // fall through
      }
      return {} as Record<string, string>;
    }),
  );

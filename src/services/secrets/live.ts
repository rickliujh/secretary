import { invoke } from "@tauri-apps/api/core";
import { Effect, Layer, Option } from "effect";
import { forgetSecret, redact, registerSecret } from "@/lib/redact";
import { Secrets, SecretsError } from ".";

const fail = (name: string) => (cause: unknown) =>
  new SecretsError({ name, message: redact(String(cause)) });

/**
 * Keychain access with an in-memory cache: sync makes many requests and each
 * would otherwise cost a keychain round trip. Writes go through this service,
 * so the cache stays correct unless the keychain is edited externally, which a
 * restart picks up.
 */
export const SecretsLive = Layer.sync(Secrets, () => {
  const cache = new Map<string, string | null>();
  const read = (name: string) =>
    Effect.tryPromise({
      try: () => invoke<string | null>("secret_get", { name }),
      catch: fail(name),
    }).pipe(
      Effect.tap((value) => {
        registerSecret(value);
        cache.set(name, value);
      }),
    );
  return Secrets.of({
    get: (name) =>
      (cache.has(name) ? Effect.succeed(cache.get(name) ?? null) : read(name)).pipe(
        Effect.map(Option.fromNullable),
      ),
    set: (name, value) =>
      Effect.sync(() => registerSecret(value)).pipe(
        Effect.zipRight(
          Effect.tryPromise({
            try: () => invoke<void>("secret_set", { name, value }),
            catch: fail(name),
          }),
        ),
        Effect.tap(() => cache.set(name, value)),
      ),
    remove: (name) =>
      Effect.tryPromise({
        try: () => invoke<void>("secret_delete", { name }),
        catch: fail(name),
      }).pipe(
        Effect.tap(() => {
          forgetSecret(cache.get(name));
          cache.set(name, null);
        }),
      ),
  });
});

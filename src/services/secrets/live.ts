import { invoke } from "@tauri-apps/api/core";
import { Effect, Layer, Option } from "effect";
import { forgetSecret, redact, registerSecret } from "@/lib/redact";
import { Secrets, SecretsError } from ".";

const fail = (name: string) => (cause: unknown) =>
  new SecretsError({ name, message: redact(String(cause)) });

export const SecretsLive = Layer.succeed(Secrets, {
  get: (name) =>
    Effect.tryPromise({
      try: () => invoke<string | null>("secret_get", { name }),
      catch: fail(name),
    }).pipe(
      Effect.tap((value) => registerSecret(value)),
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
    ),
  remove: (name) =>
    Effect.tryPromise({
      try: () => invoke<string | null>("secret_get", { name }),
      catch: fail(name),
    }).pipe(
      Effect.tap((old) => forgetSecret(old)),
      Effect.zipRight(
        Effect.tryPromise({
          try: () => invoke<void>("secret_delete", { name }),
          catch: fail(name),
        }),
      ),
    ),
});

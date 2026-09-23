import { Effect, Layer, Option } from "effect";
import { registerSecret } from "@/lib/redact";
import { Secrets } from ".";

/** In-memory keychain. Pass initial entries to pre-seed. */
export const makeSecretsTest = (initial: Record<string, string> = {}) => {
  const store = new Map(Object.entries(initial));
  for (const v of store.values()) registerSecret(v);
  return Layer.succeed(Secrets, {
    get: (name) => Effect.sync(() => Option.fromNullable(store.get(name))),
    set: (name, value) =>
      Effect.sync(() => {
        registerSecret(value);
        store.set(name, value);
      }),
    remove: (name) =>
      Effect.sync(() => {
        store.delete(name);
      }),
  });
};

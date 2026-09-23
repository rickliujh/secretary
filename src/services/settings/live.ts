import { load, type Store } from "@tauri-apps/plugin-store";
import { Effect, Layer } from "effect";
import { decodeSettings, Settings, SettingsError } from ".";

export const SETTINGS_FILE = "settings.json";
const KEY = "settings";

const make = Effect.gen(function* () {
  const store: Store = yield* Effect.tryPromise({
    try: () => load(SETTINGS_FILE, { autoSave: false, defaults: {} }),
    catch: (cause) => new SettingsError({ message: `Could not open settings: ${String(cause)}` }),
  });
  // Serialise updates so two quick saves cannot interleave read-modify-write.
  const lock = yield* Effect.makeSemaphore(1);

  const read = Effect.tryPromise({
    try: () => store.get<unknown>(KEY),
    catch: (cause) => new SettingsError({ message: `Could not read settings: ${String(cause)}` }),
  }).pipe(Effect.flatMap(decodeSettings));

  return Settings.of({
    get: read,
    update: (f) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const next = yield* decodeSettings(f(yield* read));
          yield* Effect.tryPromise({
            try: async () => {
              await store.set(KEY, next);
              await store.save();
            },
            catch: (cause) =>
              new SettingsError({ message: `Could not save settings: ${String(cause)}` }),
          });
          return next;
        }),
      ),
  });
});

export const SettingsLive = Layer.effect(Settings, make);

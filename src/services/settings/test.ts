import { Effect, Layer, Ref } from "effect";
import { type AppSettings, decodeSettings, defaultSettings, Settings } from ".";

export const makeSettingsTest = (initial: Partial<AppSettings> = {}) =>
  Layer.effect(
    Settings,
    Effect.gen(function* () {
      const ref = yield* Ref.make<AppSettings>({ ...defaultSettings(), ...initial });
      return Settings.of({
        get: Ref.get(ref),
        update: (f) =>
          Effect.flatMap(Ref.get(ref), (s) => decodeSettings(f(s))).pipe(
            Effect.tap((next) => Ref.set(ref, next)),
          ),
      });
    }),
  );

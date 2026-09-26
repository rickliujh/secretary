import { Context, Data, Effect } from "effect";
import type { z } from "zod";
import { type AppSettings, defaultSettings, SettingsSchema } from "./schema";

export * from "./schema";

export class SettingsError extends Data.TaggedError("SettingsError")<{
  readonly message: string;
  readonly issues?: z.core.$ZodIssue[];
}> {}

export interface SettingsShape {
  readonly get: Effect.Effect<AppSettings, SettingsError>;
  /** Applies `f`, validates the result and persists it. */
  readonly update: (
    f: (s: AppSettings) => AppSettings,
  ) => Effect.Effect<AppSettings, SettingsError>;
}

export class Settings extends Context.Tag("Settings")<Settings, SettingsShape>() {}

/**
 * Settings for readers that can work with the defaults: when the store cannot be
 * read (the settings page reports that), they get `defaultSettings()` instead.
 */
export const settingsOrDefault = (settings: SettingsShape): Effect.Effect<AppSettings> =>
  settings.get.pipe(Effect.orElseSucceed(defaultSettings));

/** Parses stored data, filling defaults. Invalid data is an error, never silently reset. */
export const decodeSettings = (raw: unknown): Effect.Effect<AppSettings, SettingsError> => {
  const result = SettingsSchema.safeParse(raw ?? {});
  return result.success
    ? Effect.succeed(result.data)
    : Effect.fail(
        new SettingsError({
          message: `Settings are invalid: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
          issues: result.error.issues,
        }),
      );
};

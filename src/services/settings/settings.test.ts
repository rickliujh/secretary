import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  DEFAULT_JQL,
  decodeSettings,
  defaultSettings,
  ProviderSchema,
  Settings,
  SettingsSchema,
} from ".";
import { makeSettingsTest } from "./test";

describe("Settings schema", () => {
  test("empty store decodes to defaults", async () => {
    const s = await Effect.runPromise(decodeSettings(undefined));
    expect(s).toEqual(defaultSettings());
    expect(s.jira.jql).toBe(DEFAULT_JQL);
    expect(s.jira.syncIntervalMinutes).toBe(10);
    expect(s.tiers).toEqual({ fast: null, standard: null, strong: null });
    expect(s.general.outputLanguage).toBe("English");
  });

  test("every section's defaults are filled from its fields", () => {
    expect(defaultSettings()).toEqual({
      version: 1,
      providers: [],
      tiers: { fast: null, standard: null, strong: null },
      taskOverrides: {},
      jira: {
        baseUrl: "",
        deployment: "auto",
        email: "",
        jql: DEFAULT_JQL,
        trackedEpics: [],
        syncIntervalMinutes: 10,
        fields: {},
      },
      confluence: { baseUrl: "", deployment: "auto", email: "" },
      general: { outputLanguage: "English", fiscalYearStartMonth: 1 },
      dependencies: { followupDays: 3, reminders: true },
      scoring: {
        priority: 3,
        due: 4,
        blocked: 2,
        blocking: 2,
        stale: 1,
        dependency: 3,
        pinned: 10,
      },
      network: {
        proxyMode: "system",
        proxyUrl: "",
        noProxy: "localhost,127.0.0.1",
        proxyUsername: "",
      },
    });
    // Defaults are fresh objects, not one shared instance.
    expect(defaultSettings().jira.trackedEpics).not.toBe(defaultSettings().jira.trackedEpics);
  });

  test("partial data keeps stored values and fills the rest", async () => {
    const s = await Effect.runPromise(
      decodeSettings({ jira: { baseUrl: "https://jira.example.com" } }),
    );
    expect(s.jira.baseUrl).toBe("https://jira.example.com");
    expect(s.jira.jql).toBe(DEFAULT_JQL);
  });

  test("invalid data fails instead of resetting", async () => {
    const exit = await Effect.runPromiseExit(decodeSettings({ jira: { baseUrl: "ftp://x" } }));
    expect(exit._tag).toBe("Failure");
  });

  test("provider defaults are filled", () => {
    const p = ProviderSchema.parse({
      id: "p1",
      name: "Anthropic",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
    });
    expect(p.authStyle).toBe("x-api-key");
    expect(p.thinking).toBe("default");
    expect(p.jsonSchemaOutputs).toBe(true);
  });

  test("the settings shape has no field that could hold a secret", () => {
    const text = JSON.stringify(Object.keys(ProviderSchema.shape));
    expect(text).not.toMatch(/key"|token|pat"|password|secret/i);
    expect(Object.keys(SettingsSchema.shape.jira.unwrap().shape)).not.toContain("pat");
  });
});

describe("Settings service", () => {
  test("update validates and persists", async () => {
    const program = Effect.gen(function* () {
      const settings = yield* Settings;
      yield* settings.update((s) => ({ ...s, jira: { ...s.jira, trackedEpics: ["ABC-1"] } }));
      const bad = yield* Effect.either(
        settings.update((s) => ({ ...s, jira: { ...s.jira, syncIntervalMinutes: 0 } })),
      );
      return { after: yield* settings.get, bad };
    });
    const { after, bad } = await Effect.runPromise(Effect.provide(program, makeSettingsTest()));
    expect(after.jira.trackedEpics).toEqual(["ABC-1"]);
    expect(after.jira.syncIntervalMinutes).toBe(10);
    expect(bad._tag).toBe("Left");
  });
});

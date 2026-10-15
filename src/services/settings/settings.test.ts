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
import { DEFAULT_SUGGESTED_PROMPTS } from "./schema";
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
      dataSources: [],
      suggestedPrompts: DEFAULT_SUGGESTED_PROMPTS,
      obsidian: { cliPath: "" },
      report: { style: "talk_track" },
      storage: { limitMb: 1024, autoCleanup: true },
      capture: {
        shortcut: "CommandOrControl+Shift+Space",
        closeToTray: true,
        trayNoticeShown: false,
      },
      scoring: {
        priority: 3,
        due: 4,
        blocked: 2,
        blocking: 2,
        stale: 1,
        dependency: 3,
        pinned: 10,
      },
      smallAsks: {
        projectKey: "",
        label: "small-ask",
        joinActiveSprint: true,
        hintDismissed: false,
        defaultPoints: null,
      },
      sprint: { daysPerPoint: null, lastDay: "jira" },
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

  test("small-asks home: defaults, and labels without spaces (D44)", () => {
    // A store from before the last-day setting parses with Jira's end time (D57).
    expect(SettingsSchema.parse({ sprint: { daysPerPoint: 0.5 } }).sprint).toEqual({
      daysPerPoint: 0.5,
      lastDay: "jira",
    });
    expect(SettingsSchema.parse({ smallAsks: { projectKey: "ASK" } }).smallAsks).toEqual({
      projectKey: "ASK",
      label: "small-ask",
      joinActiveSprint: true,
      hintDismissed: false,
      defaultPoints: null,
    });
    expect(SettingsSchema.safeParse({ smallAsks: { label: "small ask" } }).success).toBe(false);
    expect(SettingsSchema.safeParse({ smallAsks: { projectKey: "ask" } }).success).toBe(false);
  });

  test("the tray notice flag defaults to unsent and survives a stored capture section", () => {
    expect(SettingsSchema.parse({ capture: { closeToTray: false } }).capture).toEqual({
      shortcut: "CommandOrControl+Shift+Space",
      closeToTray: false,
      trayNoticeShown: false,
    });
    expect(
      SettingsSchema.parse({ capture: { trayNoticeShown: true } }).capture.trayNoticeShown,
    ).toBe(true);
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

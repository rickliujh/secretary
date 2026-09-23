/** Shared test wiring: real service implementations over stubs and an in-memory DB. */
import { Layer } from "effect";
import { DbTest } from "@/services/db/test";
import type { FetchFn } from "@/services/http";
import { makeFetcherTest } from "@/services/http";
import { JiraClientLive } from "@/services/jira/live";
import { secretNames } from "@/services/secrets";
import { makeSecretsTest } from "@/services/secrets/test";
import { type AppSettings, defaultSettings } from "@/services/settings/schema";
import { makeSettingsTest } from "@/services/settings/test";

export const JIRA_BASE = "https://jira.example.com";

export function jiraSettings(patch: Partial<AppSettings["jira"]> = {}): AppSettings {
  const s = defaultSettings();
  return { ...s, jira: { ...s.jira, baseUrl: JIRA_BASE, ...patch } };
}

/** Settings, Secrets, Fetcher, Db and a live JiraClient on top of them. */
export function jiraTestLayer(fetch: FetchFn, settings: AppSettings = jiraSettings()) {
  const base = Layer.mergeAll(
    makeSettingsTest(settings),
    makeSecretsTest({ [secretNames.jiraPat]: "test-pat-000000" }),
    makeFetcherTest(fetch),
    DbTest,
  );
  return Layer.provideMerge(JiraClientLive, base);
}

export const SETTINGS_TABS = [
  { value: "general", label: "General" },
  { value: "providers", label: "Providers" },
  { value: "models", label: "Models" },
  { value: "ranking", label: "Ranking" },
  { value: "jira", label: "Jira" },
  { value: "confluence", label: "Confluence" },
  { value: "usage", label: "Usage" },
  { value: "data", label: "Data" },
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number]["value"];

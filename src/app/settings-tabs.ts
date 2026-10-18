export const SETTINGS_TABS = [
  { value: "general", label: "General" },
  /** The work model: switches and budgets (D61), later the standing instructions. */
  { value: "secretary", label: "Secretary" },
  { value: "providers", label: "Providers" },
  { value: "models", label: "Models" },
  { value: "jira", label: "Jira" },
  { value: "confluence", label: "Confluence" },
  { value: "sources", label: "Data sources" },
  { value: "usage", label: "Usage" },
  { value: "data", label: "Data" },
  /** Task routing, ranking weights and evaluation replay (D50). */
  { value: "advanced", label: "Advanced" },
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number]["value"];

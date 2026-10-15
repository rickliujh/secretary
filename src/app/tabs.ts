/**
 * Pages made of tabs (D50): the tab is a search parameter, so links, the
 * command palette and the redirects from the old paths can open one.
 */
import { z } from "zod";

export const SPRINT_TABS = [
  { value: "plan", label: "Plan" },
  { value: "report", label: "Report" },
  { value: "epics", label: "Epics" },
] as const;
export type SprintTab = (typeof SPRINT_TABS)[number]["value"];

export const CONTEXT_TABS = [
  { value: "people", label: "People" },
  { value: "teams", label: "Teams" },
  { value: "memory", label: "Memory" },
] as const;
export type ContextTab = (typeof CONTEXT_TABS)[number]["value"];

/** The Memory tab's own lists: rules and preferences, or corrections. */
export const MEMORY_LISTS = ["memories", "corrections"] as const;
export type MemoryList = (typeof MEMORY_LISTS)[number];

const values = <T extends string>(tabs: readonly { value: T }[]) =>
  tabs.map((t) => t.value) as [T, ...T[]];

/** `/sprint`: an unknown or missing tab opens Plan. */
export const SprintSearch = z.object({
  tab: z.enum(values(SPRINT_TABS)).default("plan").catch("plan"),
});

/**
 * `/context`: an unknown or missing tab opens People. `id` is the open contact on
 * People or the open team on Teams; `list` is the Memory tab's list.
 */
export const ContextSearch = z.object({
  tab: z.enum(values(CONTEXT_TABS)).default("people").catch("people"),
  id: z.string().optional().catch(undefined),
  list: z.enum(MEMORY_LISTS).default("memories").catch("memories"),
});

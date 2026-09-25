/** Typed access to the `sync_state` key/value table. */
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { syncState } from "@/db/schema";
import { query } from "@/services/db";
import type { SprintInfo } from "@/services/sprints/calendar";

export const SYNC_KEYS = {
  watermark: "jira.watermark",
  lastSyncAt: "jira.lastSyncAt",
  lastFullSyncAt: "jira.lastFullSyncAt",
  fields: "jira.fields",
  timeZone: "jira.timeZone",
  username: "jira.username",
  /** JSON { [projectKey]: { issueTypes: string[], statuses: string[], at } } from /project/{key}/statuses. */
  projectMeta: "jira.projectMeta",
  /** JSON SprintState: every known sprint with dates, for the sprint calendar (D23). */
  sprints: "jira.sprints",
} as const;

export const getState = (key: string) =>
  query((db) => db.select().from(syncState).where(eq(syncState.key, key)).get()).pipe(
    Effect.map((row) => row?.value),
  );

export const setState = (key: string, value: string) =>
  query((db) =>
    db
      .insert(syncState)
      .values({ key, value })
      .onConflictDoUpdate({ target: syncState.key, set: { value } }),
  );

export type ProjectMeta = Record<string, { issueTypes: string[]; statuses: string[] }>;

export const parseProjectMeta = (value: string | undefined): ProjectMeta => {
  if (!value) return {};
  try {
    return JSON.parse(value) as ProjectMeta;
  } catch {
    return {};
  }
};

export type SprintState = {
  sprints: SprintInfo[];
  /** Boards whose whole sprint history was fetched from the Agile API. */
  completeBoards: number[];
  /** Project keys seen on each board's issues, to name boards in prompts. */
  boardProjects: Record<string, string[]>;
};

export const parseSprintState = (value: string | undefined): SprintState => {
  const empty: SprintState = { sprints: [], completeBoards: [], boardProjects: {} };
  if (!value) return empty;
  try {
    return { ...empty, ...(JSON.parse(value) as Partial<SprintState>) };
  } catch {
    return empty;
  }
};

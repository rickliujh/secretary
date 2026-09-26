/** Typed access to the `sync_state` key/value table. */
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { z } from "zod";
import { syncState } from "@/db/schema";
import { readJson } from "@/lib/json";
import { query } from "@/services/db";
import type { FieldIds } from "@/services/jira/fields";
import type { SprintInfo } from "@/services/sprints/calendar";

export const SYNC_KEYS = {
  watermark: "jira.watermark",
  lastSyncAt: "jira.lastSyncAt",
  lastFullSyncAt: "jira.lastFullSyncAt",
  fields: "jira.fields",
  timeZone: "jira.timeZone",
  username: "jira.username",
  /** JSON { [projectKey]: { issueTypes: string[], statuses: string[] } } from /project/{key}/statuses. */
  projectMeta: "jira.projectMeta",
  /** JSON SprintState: every known sprint with dates, for the sprint calendar (D23). */
  sprints: "jira.sprints",
  /** JSON CleanupResult of the last storage cleanup (D34). */
  lastCleanup: "app.lastCleanup",
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

const FieldIdsSchema = z.object({
  epicLink: z.string().optional(),
  epicName: z.string().optional(),
  sprint: z.string().optional(),
  storyPoints: z.string().optional(),
}) satisfies z.ZodType<FieldIds>;

export const parseFieldIds = (value: string | undefined): FieldIds =>
  readJson(value, FieldIdsSchema, {});

const ProjectMetaSchema = z.record(
  z.string(),
  z.object({
    issueTypes: z.array(z.string()).default([]),
    statuses: z.array(z.string()).default([]),
  }),
);
export type ProjectMeta = z.infer<typeof ProjectMetaSchema>;

export const parseProjectMeta = (value: string | undefined): ProjectMeta =>
  readJson(value, ProjectMetaSchema, {});

const SprintInfoSchema = z.object({
  id: z.number(),
  name: z.string(),
  state: z.string(),
  boardId: z.number().nullable().default(null),
  start: z.string().nullable().default(null),
  end: z.string().nullable().default(null),
}) satisfies z.ZodType<SprintInfo>;

const SprintStateSchema = z.object({
  sprints: z.array(SprintInfoSchema).default([]),
  /** Boards whose whole sprint history was fetched from the Agile API. */
  completeBoards: z.array(z.number()).default([]),
  /** Project keys seen on each board's issues, to name boards in prompts. */
  boardProjects: z.record(z.string(), z.array(z.string())).default({}),
});
export type SprintState = z.infer<typeof SprintStateSchema>;

export const parseSprintState = (value: string | undefined): SprintState =>
  readJson(value, SprintStateSchema, { sprints: [], completeBoards: [], boardProjects: {} });

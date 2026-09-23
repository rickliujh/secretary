/** Typed access to the `sync_state` key/value table. */
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { syncState } from "@/db/schema";
import { query } from "@/services/db";

export const SYNC_KEYS = {
  watermark: "jira.watermark",
  lastSyncAt: "jira.lastSyncAt",
  lastFullSyncAt: "jira.lastFullSyncAt",
  fields: "jira.fields",
  timeZone: "jira.timeZone",
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

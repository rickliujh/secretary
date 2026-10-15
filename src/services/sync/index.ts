import { Context, Data, type Effect, type Stream } from "effect";
import type { DbError } from "@/services/db";
import type { JiraError } from "@/services/jira";
import type { FieldIds } from "@/services/jira/fields";

export class SyncError extends Data.TaggedError("SyncError")<{
  readonly kind: "busy" | "scope";
  readonly message: string;
}> {}

export type SyncResult = {
  full: boolean;
  fetched: number;
  staleMarked: number;
  durationMs: number;
};

export type SyncStatus = {
  running: boolean;
  full: boolean;
  phase: string | null;
  fetched: number;
  total: number | null;
  lastSyncAt: string | null;
  lastFullSyncAt: string | null;
  lastError: string | null;
  lastResult: SyncResult | null;
};

export type FieldInfo = { discovered: FieldIds; effective: FieldIds };

export interface SyncShape {
  /** Runs a sync. `full` forces a full resync with stale marking. Fails with `busy` if one is running. */
  readonly run: (opts?: {
    full?: boolean;
  }) => Effect.Effect<SyncResult, SyncError | JiraError | DbError>;
  readonly status: Effect.Effect<SyncStatus>;
  readonly changes: Stream.Stream<SyncStatus>;
  /** Re-reads `/field` and stores the discovered ids. */
  readonly discoverFields: Effect.Effect<FieldInfo, JiraError | DbError>;
  /** Last discovered and effective field ids without calling Jira. */
  readonly fieldInfo: Effect.Effect<FieldInfo, DbError>;
  /**
   * Re-fetches one issue (with comments) and stores Jira's version. Used after
   * writes. A cached issue keeps its scope flag (`stale`): one read does not say
   * whether the sync scope holds it. A new issue is in scope, unless `candidate`
   * is set: an issue read only because pasted text named it (D45) is stored out
   * of scope, so it is a candidate by its key and nothing else (no project
   * lists, tickets tree, ranking or blocker checks), and cleanup removes it.
   * When the issue blocks one of the user's open issues, its blocker state
   * (`jira.blockers`) is updated and those issues get the wake-up check.
   */
  readonly refreshIssue: (
    key: string,
    opts?: { candidate?: boolean },
  ) => Effect.Effect<void, JiraError | DbError>;
}

export class Sync extends Context.Tag("Sync")<Sync, SyncShape>() {}

/** Full resync interval (design.md section 5). */
export const FULL_RESYNC_MS = 7 * 24 * 60 * 60 * 1000;

import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { Effect, Layer, Option, SubscriptionRef } from "effect";
import { jiraIssues } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { logger } from "@/lib/log";
import { Db, type DbError, query } from "@/services/db";
import { JiraClient, type JiraError, type RawIssue } from "@/services/jira";
import { discoverFieldIds, effectiveFieldIds, type FieldIds } from "@/services/jira/fields";
import { type CommentRow, issueFields, mapComment, mapIssue } from "@/services/jira/mapping";
import { Settings } from "@/services/settings";
import {
  type FieldInfo,
  FULL_RESYNC_MS,
  Sync,
  SyncError,
  type SyncResult,
  type SyncStatus,
} from ".";
import { buildScopeJql, chunk, withUpdatedSince } from "./jql";
import { getState, SYNC_KEYS, setState } from "./state";
import { replaceComments, upsertIssues } from "./upsert";

const PAGE_SIZE = 100;
const SUBTASK_PARENTS_PER_QUERY = 100;

const initialStatus: SyncStatus = {
  running: false,
  full: false,
  phase: null,
  fetched: 0,
  total: null,
  lastSyncAt: null,
  lastFullSyncAt: null,
  lastError: null,
  lastResult: null,
};

const parseFieldIds = (value: string | undefined): FieldIds => {
  if (!value) return {};
  try {
    return JSON.parse(value) as FieldIds;
  } catch {
    return {};
  }
};

const make = Effect.gen(function* () {
  const settingsSvc = yield* Settings;
  const jira = yield* JiraClient;
  const db = yield* Db;
  const lock = yield* Effect.makeSemaphore(1);
  const status = yield* SubscriptionRef.make(initialStatus);

  const withDb = <A, E>(e: Effect.Effect<A, E, Db>) => Effect.provideService(e, Db, db);
  const patch = (p: Partial<SyncStatus>) => SubscriptionRef.update(status, (s) => ({ ...s, ...p }));

  // Seed timestamps from the database so the UI shows them after a restart.
  yield* Effect.all([getState(SYNC_KEYS.lastSyncAt), getState(SYNC_KEYS.lastFullSyncAt)]).pipe(
    withDb,
    Effect.flatMap(([lastSyncAt, lastFullSyncAt]) =>
      patch({ lastSyncAt: lastSyncAt ?? null, lastFullSyncAt: lastFullSyncAt ?? null }),
    ),
    Effect.catchAll(() => Effect.void),
  );

  const fieldInfo = Effect.gen(function* () {
    const settings = yield* settingsSvc.get.pipe(Effect.orElseSucceed(() => undefined));
    const discovered = parseFieldIds(yield* withDb(getState(SYNC_KEYS.fields)));
    return {
      discovered,
      effective: effectiveFieldIds(discovered, settings?.jira.fields ?? {}),
    } satisfies FieldInfo;
  });

  const discoverFields = Effect.gen(function* () {
    const discovered = discoverFieldIds(yield* jira.fields);
    yield* withDb(setState(SYNC_KEYS.fields, JSON.stringify(discovered)));
    return yield* fieldInfo;
  });

  /** Fetches the comments Jira did not embed in the search response. */
  const allComments = (key: string): Effect.Effect<CommentRow[], JiraError> =>
    Effect.gen(function* () {
      const rows: CommentRow[] = [];
      let startAt = 0;
      for (;;) {
        const page = yield* jira.getComments(key, startAt);
        for (const c of page.comments) {
          const row = mapComment(key, c);
          if (row) rows.push(row);
        }
        startAt += page.comments.length;
        if (page.comments.length === 0 || startAt >= page.total) return rows;
      }
    });

  type RunCtx = {
    fields: string[];
    fieldIds: FieldIds;
    tracked: ReadonlySet<string>;
    timeZone?: string;
    watermark?: string;
    syncedAt: string;
  };

  /** Pages through one JQL query, storing issues and comments. Returns max `updated`. */
  const syncQuery = (jql: string, ctx: RunCtx, phase: string) =>
    Effect.gen(function* () {
      let startAt = 0;
      let fetched = 0;
      let maxUpdated: string | undefined;
      yield* patch({ phase });
      for (;;) {
        const page = yield* jira.search({
          jql,
          startAt,
          maxResults: PAGE_SIZE,
          fields: ctx.fields,
          expand: ["renderedFields"],
        });
        if (page.issues.length === 0) break;
        const mapped = page.issues.map((raw: RawIssue) =>
          mapIssue(raw, {
            fieldIds: ctx.fieldIds,
            trackedEpics: ctx.tracked,
            syncedAt: ctx.syncedAt,
          }),
        );
        const comments: CommentRow[] = [];
        for (const m of mapped) {
          comments.push(...(m.commentsComplete ? m.comments : yield* allComments(m.issue.key)));
          if (!maxUpdated || m.issue.updated > maxUpdated) maxUpdated = m.issue.updated;
        }
        yield* withDb(upsertIssues(mapped.map((m) => m.issue)));
        yield* withDb(
          replaceComments(
            mapped.map((m) => m.issue.key),
            comments,
          ),
        );
        fetched += page.issues.length;
        startAt += page.issues.length;
        yield* SubscriptionRef.update(status, (s) => ({
          ...s,
          fetched: s.fetched + page.issues.length,
          total: page.total,
        }));
        if (startAt >= page.total) break;
      }
      return { fetched, maxUpdated };
    });

  const runOnce = (opts: {
    full?: boolean;
  }): Effect.Effect<SyncResult, SyncError | JiraError | DbError> =>
    Effect.gen(function* () {
      const started = Date.now();
      const settings = yield* settingsSvc.get.pipe(
        Effect.mapError((e) => new SyncError({ kind: "scope", message: e.message })),
      );
      const lastFull = yield* withDb(getState(SYNC_KEYS.lastFullSyncAt));
      const full =
        opts.full || !lastFull || Date.now() - new Date(lastFull).getTime() > FULL_RESYNC_MS;
      yield* patch({
        running: true,
        full,
        phase: "Connecting",
        fetched: 0,
        total: null,
        lastError: null,
      });

      const me = yield* jira.myself;
      if (me.timeZone) yield* withDb(setState(SYNC_KEYS.timeZone, me.timeZone));
      const { effective: fieldIds } = yield* discoverFields;

      const tracked = new Set(settings.jira.trackedEpics);
      const scope = yield* Effect.try({
        try: () =>
          buildScopeJql({
            userJql: settings.jira.jql,
            trackedEpics: settings.jira.trackedEpics,
            epicLinkFieldId: fieldIds.epicLink,
          }),
        catch: (e) =>
          new SyncError({ kind: "scope", message: e instanceof Error ? e.message : String(e) }),
      });
      const ctx: RunCtx = {
        fields: issueFields(fieldIds),
        fieldIds,
        tracked,
        timeZone: me.timeZone,
        watermark: full ? undefined : yield* withDb(getState(SYNC_KEYS.watermark)),
        syncedAt: nowIso(),
      };

      const main = yield* syncQuery(
        withUpdatedSince(scope, ctx.watermark, ctx.timeZone),
        ctx,
        "Fetching issues",
      );
      let fetched = main.fetched;
      let maxUpdated = main.maxUpdated;

      // Sub-tasks of stories under tracked epics carry no Epic Link (design.md section 5, step 6).
      if (tracked.size > 0) {
        const parents = yield* query((d) =>
          d
            .select({ key: jiraIssues.key })
            .from(jiraIssues)
            .where(and(inArray(jiraIssues.epicKey, [...tracked]), eq(jiraIssues.isSubtask, false)))
            .all(),
        ).pipe(withDb);
        for (const keys of chunk(
          parents.map((p) => p.key),
          SUBTASK_PARENTS_PER_QUERY,
        )) {
          const r = yield* syncQuery(
            withUpdatedSince(`parent in (${keys.join(", ")})`, ctx.watermark, ctx.timeZone),
            ctx,
            "Fetching sub-tasks",
          );
          fetched += r.fetched;
          if (r.maxUpdated && (!maxUpdated || r.maxUpdated > maxUpdated)) maxUpdated = r.maxUpdated;
        }
      }

      // Tracked-epic flags follow settings even for issues not updated in this run.
      yield* query((d) =>
        d.update(jiraIssues).set({
          isTrackedEpic: tracked.size > 0 ? inArray(jiraIssues.key, [...tracked]) : sql`0`,
        }),
      ).pipe(withDb);

      let staleMarked = 0;
      if (full) {
        const stale = yield* query((d) =>
          d
            .update(jiraIssues)
            .set({ stale: true })
            .where(and(lt(jiraIssues.syncedAt, ctx.syncedAt), eq(jiraIssues.stale, false)))
            .returning({ key: jiraIssues.key }),
        ).pipe(withDb);
        staleMarked = stale.length;
      }

      const previous = yield* withDb(getState(SYNC_KEYS.watermark));
      if (maxUpdated && (!previous || maxUpdated > previous))
        yield* withDb(setState(SYNC_KEYS.watermark, maxUpdated));
      const finishedAt = nowIso();
      yield* withDb(setState(SYNC_KEYS.lastSyncAt, finishedAt));
      if (full) yield* withDb(setState(SYNC_KEYS.lastFullSyncAt, finishedAt));

      const result: SyncResult = { full, fetched, staleMarked, durationMs: Date.now() - started };
      yield* patch({
        running: false,
        phase: null,
        lastSyncAt: finishedAt,
        ...(full ? { lastFullSyncAt: finishedAt } : {}),
        lastResult: result,
      });
      logger.info(
        `Jira sync done: ${fetched} issues, full=${full}, stale=${staleMarked}, ${result.durationMs} ms`,
      );
      return result;
    }).pipe(
      Effect.tapError((e) =>
        patch({ running: false, phase: null, lastError: e.message }).pipe(
          Effect.zipRight(Effect.sync(() => logger.warn("Jira sync failed", e.message))),
        ),
      ),
      Effect.onInterrupt(() =>
        patch({ running: false, phase: null, lastError: "Sync was cancelled" }),
      ),
    );

  const refreshIssue = (key: string) =>
    Effect.gen(function* () {
      const settings = yield* settingsSvc.get.pipe(Effect.orElseSucceed(() => undefined));
      const { effective: fieldIds } = yield* withDb(fieldInfo);
      const raw = yield* jira.getIssue(key, {
        fields: issueFields(fieldIds),
        expand: ["renderedFields"],
      });
      const m = mapIssue(raw, {
        fieldIds,
        trackedEpics: new Set(settings?.jira.trackedEpics ?? []),
        syncedAt: nowIso(),
      });
      const comments = m.commentsComplete ? m.comments : yield* allComments(key);
      yield* withDb(upsertIssues([m.issue]));
      yield* withDb(replaceComments([key], comments));
    });

  return Sync.of({
    refreshIssue,
    run: (opts = {}) =>
      lock
        .withPermitsIfAvailable(1)(runOnce(opts))
        .pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(new SyncError({ kind: "busy", message: "A sync is already running." })),
              onSome: Effect.succeed,
            }),
          ),
        ),
    status: SubscriptionRef.get(status),
    changes: status.changes,
    discoverFields,
    fieldInfo: withDb(fieldInfo),
  });
});

export const SyncLive = Layer.effect(Sync, make);

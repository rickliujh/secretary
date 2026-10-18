import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { Clock, Effect, Layer, Option, SubscriptionRef } from "effect";
import { jiraIssues } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { logger } from "@/lib/log";
import { type BlockerState, type LinkTypes, pickBlocksType } from "@/services/blockers/logic";
import { bindDb, Db, type DbError } from "@/services/db";
import { JiraClient, type JiraError, type RawIssue, type SearchResult } from "@/services/jira";
import { discoverFieldIds, effectiveFieldIds, type FieldIds } from "@/services/jira/fields";
import { type CommentRow, issueFields, mapComment, mapIssue } from "@/services/jira/mapping";
import { Settings, settingsOrDefault } from "@/services/settings";
import { datePart, type SprintInfo } from "@/services/sprints/calendar";
import {
  type FieldInfo,
  FULL_RESYNC_MS,
  Sync,
  SyncError,
  type SyncResult,
  type SyncStatus,
} from ".";
import { refreshBlocker, syncBlockers } from "./blockers";
import { clearReopened, deletedKeys, sweepDeleted, withoutDeleted } from "./deleted";
import { buildScopeJql, chunk, withUpdatedSince } from "./jql";
import { parentEpicsToRead } from "./parent-epics";
import {
  getState,
  parseFieldIds,
  parseProjectMeta,
  parseSprintState,
  type SprintState,
  SYNC_KEYS,
  setState,
} from "./state";
import { replaceComments, upsertIssues, type WriteOrigin } from "./upsert";

const PAGE_SIZE = 100;
const MAX_PROJECTS_WITH_META = 30;
const MAX_SPRINT_BOARDS = 10;
const MAX_SPRINT_PAGES = 20;
/** Sprints that ended longer ago than this are dropped from the calendar store. */
const SPRINT_KEEP_DAYS = 400;

const SUBTASK_PARENTS_PER_QUERY = 100;
const PARENT_EPICS_PER_QUERY = 100;

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

const make = Effect.gen(function* () {
  const settingsSvc = yield* Settings;
  const jira = yield* JiraClient;
  const { q, withDb } = bindDb(yield* Db);
  const lock = yield* Effect.makeSemaphore(1);
  /** The blocker step and a refresh's blocker update write the same state (D45). */
  const blockerLock = yield* Effect.makeSemaphore(1);
  const status = yield* SubscriptionRef.make(initialStatus);

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
    const settings = yield* settingsOrDefault(settingsSvc);
    const discovered = parseFieldIds(yield* withDb(getState(SYNC_KEYS.fields)));
    return {
      discovered,
      effective: effectiveFieldIds(discovered, settings.jira.fields),
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
    /** Sprints seen on synced issues, by id, and the projects on each board. */
    sprints: Map<number, SprintInfo>;
    boardProjects: Map<number, Set<string>>;
    /** State of every issue this run fetched, so the blocker step need not read them again. */
    returned: Map<string, BlockerState>;
  };

  /** Pages through one JQL query, storing issues and comments. Returns max `updated`. */
  const syncQuery = (jql: string, ctx: RunCtx, phase: string) =>
    Effect.gen(function* () {
      let cursor: string | null = null;
      let fetched = 0;
      let maxUpdated: string | undefined;
      yield* patch({ phase });
      for (;;) {
        const page: SearchResult = yield* jira.search({
          jql,
          cursor,
          maxResults: PAGE_SIZE,
          fields: ctx.fields,
          expand: ["renderedFields"],
        });
        if (page.issues.length === 0) break;
        const all = page.issues.map((raw: RawIssue) =>
          mapIssue(raw, {
            fieldIds: ctx.fieldIds,
            trackedEpics: ctx.tracked,
            syncedAt: ctx.syncedAt,
          }),
        );
        // A ticket a revoke deleted is never stored again, though Cloud's search
        // index may still return it for a while (FR-14.6).
        const kept = new Set(
          (yield* withDb(withoutDeleted(all.map((m) => m.issue)))).map((i) => i.key),
        );
        const mapped = all.filter((m) => kept.has(m.issue.key));
        const comments: CommentRow[] = [];
        for (const m of mapped) {
          for (const sprint of m.sprints) {
            if (sprint.id) ctx.sprints.set(sprint.id, sprint);
            if (sprint.boardId !== null)
              ctx.boardProjects.set(
                sprint.boardId,
                new Set([...(ctx.boardProjects.get(sprint.boardId) ?? []), m.issue.projectKey]),
              );
          }
          ctx.returned.set(m.issue.key, {
            status: m.issue.status,
            statusCategory: m.issue.statusCategory,
            resolvedAt: m.issue.resolved ?? null,
          });
          comments.push(...(m.commentsComplete ? m.comments : yield* allComments(m.issue.key)));
          if (!maxUpdated || m.issue.updated > maxUpdated) maxUpdated = m.issue.updated;
        }
        const cachedBefore = yield* withDb(upsertIssues(mapped.map((m) => m.issue)));
        // A ticket a revoke closed that is open again is no longer marked revoked.
        yield* withDb(clearReopened(mapped.map((m) => m.issue)));
        yield* withDb(
          replaceComments(
            mapped.map((m) => m.issue.key),
            comments,
            { cachedBefore },
          ),
        );
        fetched += page.issues.length;
        yield* SubscriptionRef.update(status, (s) => ({
          ...s,
          fetched: s.fetched + page.issues.length,
          // Cloud search reports no total; the status then shows a running count.
          total: page.total,
        }));
        cursor = page.next;
        if (!cursor) break;
      }
      return { fetched, maxUpdated };
    });

  /**
   * Reads issues by key as context for the scope, outside the watermark (D53). One
   * key the user cannot see fails a whole `key in` search with 400, so a failed
   * search is split until that key is alone and skipped. 403 and 404 skip the part;
   * any other Jira failure is logged and the part waits for the next run.
   */
  const readByKey = (keys: readonly string[], ctx: RunCtx): Effect.Effect<number, DbError> =>
    syncQuery(`key in (${keys.join(", ")})`, ctx, "Fetching epics").pipe(
      Effect.map((r) => r.fetched),
      Effect.catchTag("JiraError", (e: JiraError) => {
        if (e.status === 400 && keys.length > 1) {
          const mid = Math.ceil(keys.length / 2);
          return Effect.zipWith(
            readByKey(keys.slice(0, mid), ctx),
            readByKey(keys.slice(mid), ctx),
            (a, b) => a + b,
          );
        }
        if (e.status !== 400 && e.status !== 403 && e.status !== 404)
          logger.warn("Reading parent epics failed", e.message);
        return Effect.succeed(0);
      }),
    );

  /**
   * Sprint calendar data (design.md D23): sprints from synced issues, plus each
   * board's sprints from the Agile API, the whole history on full syncs and for new
   * boards. Boards without Jira Software or access just keep what issues showed.
   */
  const syncSprints = (ctx: RunCtx, full: boolean) =>
    Effect.gen(function* () {
      const stored = parseSprintState(yield* withDb(getState(SYNC_KEYS.sprints)));
      const byId = new Map(stored.sprints.map((s) => [s.id, s]));
      for (const s of ctx.sprints.values()) byId.set(s.id, s);
      const boardProjects = new Map(
        Object.entries(stored.boardProjects).map(([k, v]) => [Number(k), new Set(v)]),
      );
      for (const [board, keys] of ctx.boardProjects)
        boardProjects.set(board, new Set([...(boardProjects.get(board) ?? []), ...keys]));
      const complete = new Set(stored.completeBoards);
      const boards = [
        ...new Set([...byId.values()].map((s) => s.boardId).filter((b) => b !== null)),
      ].slice(0, MAX_SPRINT_BOARDS);
      for (const board of boards) {
        const history = full || !complete.has(board);
        const states = history ? ["closed", "active", "future"] : ["active", "future"];
        let startAt = 0;
        for (let page = 0; page < MAX_SPRINT_PAGES; page++) {
          const r = yield* jira.boardSprints(board, startAt, states).pipe(Effect.option);
          if (Option.isNone(r)) {
            if (history) complete.delete(board);
            break;
          }
          for (const v of r.value.values)
            byId.set(v.id, {
              id: v.id,
              name: v.name,
              state: v.state.toLowerCase(),
              boardId: v.originBoardId ?? board,
              start: datePart(v.startDate),
              end: datePart(v.endDate),
              endAt: v.endDate ?? null,
            });
          if (r.value.isLast !== false || r.value.values.length === 0) {
            if (history) complete.add(board);
            break;
          }
          startAt += r.value.values.length;
        }
      }
      const now = yield* Clock.currentTimeMillis;
      const cutoff = new Date(now - SPRINT_KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
      const state: SprintState = {
        sprints: [...byId.values()].filter((s) => !s.end || s.end >= cutoff),
        completeBoards: [...complete],
        boardProjects: Object.fromEntries(
          [...boardProjects].map(([k, v]) => [String(k), [...v].sort()]),
        ),
      };
      yield* withDb(setState(SYNC_KEYS.sprints, JSON.stringify(state)));
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
      let full =
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
      const deployment = yield* jira.deployment;
      if (me.timeZone) yield* withDb(setState(SYNC_KEYS.timeZone, me.timeZone));
      yield* withDb(setState(SYNC_KEYS.username, me.id));
      const { effective: fieldIds } = yield* discoverFields;
      // New or changed fields (a story point field found, an override set) only reach
      // tickets that are fetched again, so a change makes this run a full one.
      const fieldsKey = JSON.stringify(fieldIds);
      if (!full && fieldsKey !== (yield* withDb(getState(SYNC_KEYS.fieldsSynced)))) {
        full = true;
        yield* patch({ full });
      }

      const tracked = new Set(settings.jira.trackedEpics);
      const scope = yield* Effect.try({
        try: () =>
          buildScopeJql({
            userJql: settings.jira.jql,
            trackedEpics: settings.jira.trackedEpics,
            // Cloud retired the Epic Link JQL function; `parent in (...)` covers epics there.
            epicLinkFieldId: deployment === "cloud" ? undefined : fieldIds.epicLink,
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
        sprints: new Map(),
        boardProjects: new Map(),
        returned: new Map(),
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
        const parents = yield* q((d) =>
          d
            .select({ key: jiraIssues.key })
            .from(jiraIssues)
            .where(and(inArray(jiraIssues.epicKey, [...tracked]), eq(jiraIssues.isSubtask, false)))
            .all(),
        );
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

      // Epics the synced issues sit under that the scope left out, so pickers,
      // intake and reports can name and offer them (D53). They do not move the
      // watermark, which only tracks the scope.
      const epicRefs = yield* q((d) =>
        d
          .select({
            key: jiraIssues.key,
            epicKey: jiraIssues.epicKey,
            stale: jiraIssues.stale,
            syncedAt: jiraIssues.syncedAt,
          })
          .from(jiraIssues)
          .all(),
      );
      const deleted = yield* withDb(deletedKeys);
      for (const keys of chunk(
        parentEpicsToRead(epicRefs, { full, syncedAt: ctx.syncedAt }).filter(
          (k) => !deleted.has(k),
        ),
        PARENT_EPICS_PER_QUERY,
      ))
        fetched += yield* readByKey(keys, ctx);
      // A page read before a revoke deleted its ticket and written after it.
      yield* withDb(sweepDeleted);

      // Real issue types and statuses per project, so intake validation does not
      // depend on which tickets happen to be cached. Refreshed on full syncs and
      // for projects seen for the first time; failures just keep the old data.
      yield* patch({ phase: "Reading project metadata" });
      const projectKeys = (yield* q((d) =>
        d
          .selectDistinct({ key: jiraIssues.projectKey })
          .from(jiraIssues)
          .where(eq(jiraIssues.stale, false))
          .all(),
      )).map((r) => r.key);
      const meta = parseProjectMeta(yield* withDb(getState(SYNC_KEYS.projectMeta)));
      let metaChanged = false;
      // The small-asks home may hold none of the synced issues yet (D44).
      const home = settings.smallAsks.projectKey;
      const metaKeys = [
        ...(home ? [home] : []),
        ...projectKeys.filter((k) => k !== home).slice(0, MAX_PROJECTS_WITH_META),
      ];
      for (const key of metaKeys) {
        if (!full && meta[key]) continue;
        const types = yield* jira.projectStatuses(key).pipe(Effect.option);
        if (types._tag === "None") continue;
        meta[key] = {
          issueTypes: [...new Set(types.value.map((t) => t.name))].sort(),
          statuses: [...new Set(types.value.flatMap((t) => t.statuses.map((x) => x.name)))].sort(),
          // Jira's flag, so a sub-task type with another name is known as one (D44).
          // A response without the flag leaves it unknown; the name decides then.
          ...(types.value.some((t) => t.subtask !== undefined)
            ? {
                subtaskTypes: [
                  ...new Set(types.value.filter((t) => t.subtask).map((t) => t.name)),
                ].sort(),
              }
            : {}),
        };
        metaChanged = true;
      }
      if (metaChanged) yield* withDb(setState(SYNC_KEYS.projectMeta, JSON.stringify(meta)));

      yield* patch({ phase: "Reading sprints" });
      yield* syncSprints(ctx, full);

      // The "blocks" link type, for proposing "blocked by" links (D45).
      if (full || !(yield* withDb(getState(SYNC_KEYS.linkTypes)))) {
        const types = yield* jira.issueLinkTypes.pipe(Effect.option);
        if (Option.isSome(types))
          yield* withDb(
            setState(
              SYNC_KEYS.linkTypes,
              JSON.stringify({ blocks: pickBlocksType(types.value) } satisfies LinkTypes),
            ),
          );
      }

      // Tracked-epic flags follow settings even for issues not updated in this run.
      yield* q((d) =>
        d.update(jiraIssues).set({
          isTrackedEpic: tracked.size > 0 ? inArray(jiraIssues.key, [...tracked]) : sql`0`,
        }),
      );

      let staleMarked = 0;
      if (full) {
        const stale = yield* q((d) =>
          d
            .update(jiraIssues)
            .set({ stale: true })
            .where(and(lt(jiraIssues.syncedAt, ctx.syncedAt), eq(jiraIssues.stale, false)))
            .returning({ key: jiraIssues.key }),
        );
        staleMarked = stale.length;
      }

      // Blockers outside this run (or the scope) are read fresh; woken issues are marked (D45).
      yield* patch({ phase: "Checking blockers" });
      const blockers = yield* syncBlockers({
        me: me.id,
        returned: ctx.returned,
        at: nowIso(),
      }).pipe(
        withDb,
        Effect.provideService(JiraClient, jira),
        blockerLock.withPermits(1),
        Effect.catchAll((e) =>
          Effect.sync(() => {
            logger.warn("Blocker check failed", e.message);
            return null;
          }),
        ),
      );
      if (blockers?.woke.length) logger.info(`Unblocked: ${blockers.woke.join(", ")}`);

      const previous = yield* withDb(getState(SYNC_KEYS.watermark));
      if (maxUpdated && (!previous || maxUpdated > previous))
        yield* withDb(setState(SYNC_KEYS.watermark, maxUpdated));
      const finishedAt = nowIso();
      yield* withDb(setState(SYNC_KEYS.lastSyncAt, finishedAt));
      if (full) {
        yield* withDb(setState(SYNC_KEYS.lastFullSyncAt, finishedAt));
        yield* withDb(setState(SYNC_KEYS.fieldsSynced, fieldsKey));
      }

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

  const refreshIssue = (key: string, opts: { candidate?: boolean; origin?: WriteOrigin } = {}) =>
    Effect.gen(function* () {
      const settings = yield* settingsOrDefault(settingsSvc);
      const { effective: fieldIds } = yield* withDb(fieldInfo);
      const raw = yield* jira.getIssue(key, {
        fields: issueFields(fieldIds),
        expand: ["renderedFields"],
      });
      const m = mapIssue(raw, {
        fieldIds,
        trackedEpics: new Set(settings.jira.trackedEpics),
        syncedAt: nowIso(),
      });
      // One read says nothing about the sync scope: a cached issue keeps its flag,
      // and an issue read only as a candidate stays out of scope (D45 review).
      const cached = yield* q((d) =>
        d
          .select({ stale: jiraIssues.stale })
          .from(jiraIssues)
          .where(eq(jiraIssues.key, m.issue.key))
          .get(),
      );
      if ((yield* withDb(withoutDeleted([m.issue]))).length === 0) {
        logger.info(`${m.issue.key} was deleted by a revoke; not stored again`);
        return;
      }
      const issue = { ...m.issue, stale: cached ? cached.stale : !!opts.candidate };
      const comments = m.commentsComplete ? m.comments : yield* allComments(m.issue.key);
      // A candidate read is no change anyone made; the rest say why the issue was read (D61).
      const origin: WriteOrigin = opts.candidate ? "none" : (opts.origin ?? "sync");
      const cachedBefore = yield* withDb(upsertIssues([issue], origin));
      yield* withDb(replaceComments([m.issue.key], comments, { origin, cachedBefore }));
      // A revoke that deleted it between the check and the write wins (FR-14.6).
      yield* withDb(sweepDeleted);
      yield* withDb(clearReopened([issue]));
      // A blocker closed (or reopened) from the app shows at once (D45 review).
      yield* blockerLock
        .withPermits(1)(
          withDb(
            refreshBlocker({
              key,
              state: {
                status: issue.status,
                statusCategory: issue.statusCategory,
                resolvedAt: issue.resolved ?? null,
              },
              at: nowIso(),
            }),
          ),
        )
        .pipe(
          // The issue itself is stored; the next sync repairs the blocker state.
          Effect.catchAll((e) =>
            Effect.sync(() => logger.warn(`Blocker update for ${key} failed`, e.message)),
          ),
        );
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

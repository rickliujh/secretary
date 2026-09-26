/**
 * `Sources` over the `source_documents` table and its FTS5 index (design.md D41).
 * Indexing is incremental: only files whose mtime or size changed are read.
 */
import { and, count, eq, inArray, notInArray, sql } from "drizzle-orm";
import { Effect, Either, Layer } from "effect";
import { z } from "zod";
import { sourceDocuments } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { readJson } from "@/lib/json";
import { bindDb, Db, type DbError } from "@/services/db";
import { retrievalFtsQuery, tokens } from "@/services/retrieval/ranking";
import { type DataSource, Settings, settingsOrDefault } from "@/services/settings";
import { getState, setState } from "@/services/sync/state";
import { ftsQuery } from "@/services/tickets/tree";
import {
  type IndexResult,
  type SearchHit,
  SourceError,
  type SourceStatus,
  Sources,
  type VaultFile,
  VaultFs,
} from ".";
import { isExcluded } from "./exclude";
import { backlinks, hitSnippet, resolveNote, titleMatches } from "./lookup";
import { type ParsedNote, parseNote } from "./obsidian";

/** sync_state key holding per-source index status (JSON StoredStatus). */
export const SOURCES_STATUS_KEY = "sources.status";
/** Files larger than this are left out of the index. */
export const MAX_NOTE_BYTES = 2 * 1024 * 1024;
/** Files read and parsed per batch; each batch is one upsert (12 columns per row). */
const BATCH = 50;
const READ_CONCURRENCY = 8;
/** Ids per DELETE ... IN (...), under SQLite's variable limit. */
const DELETE_CHUNK = 500;
const DEFAULT_LIMIT = 8;
/** bm25 column weights: title, aliases, tags, body, path. */
const BM25 = sql.raw("bm25(source_documents_fts, 10.0, 8.0, 4.0, 1.0, 2.0)");

const StoredStatusSchema = z.record(
  z.string(),
  z.object({
    lastIndexedAt: z.string().nullable().default(null),
    /** Last run, successful or not; staleness is measured from it so a broken folder is not retried on every search. */
    lastAttemptAt: z.string().nullable().default(null),
    lastError: z.string().nullable().default(null),
  }),
);
type StoredStatus = z.infer<typeof StoredStatusSchema>;

const StringList = z.array(z.string());
const docId = (sourceId: string, path: string) => `${sourceId}:${path}`;
const iso = (ms: number) => new Date(ms).toISOString();

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

/** `excluded.<column>` for an upsert's SET clause. */
const excluded = (column: { name: string }) => sql.raw(`excluded."${column.name}"`);

/** Candidates fetched per hit returned, for the title re-rank. */
const CANDIDATES_PER_HIT = 4;

const notFound = (message: string) => new SourceError({ kind: "not_found", message });

type HitRow = [
  id: string,
  sourceId: string,
  path: string,
  title: string,
  tags: string,
  mtime: number,
  snippet: string | null,
  head: string,
  aliases: string,
];

const make = Effect.gen(function* () {
  const settingsSvc = yield* Settings;
  const fs = yield* VaultFs;
  const { q, withDb } = bindDb(yield* Db);
  /** One index run at a time (timer, chat search and the settings button can overlap). */
  const lock = yield* Effect.makeSemaphore(1);

  const loadStatus = withDb(getState(SOURCES_STATUS_KEY)).pipe(
    Effect.map((v): StoredStatus => readJson(v, StoredStatusSchema, {})),
  );
  const saveStatus = (s: StoredStatus) => withDb(setState(SOURCES_STATUS_KEY, JSON.stringify(s)));

  /** Drops the rows of sources that are no longer configured. */
  const purgeRemoved = (configured: readonly DataSource[]) => {
    const ids = configured.map((s) => s.id);
    return q((d) =>
      ids.length
        ? d.delete(sourceDocuments).where(notInArray(sourceDocuments.sourceId, ids))
        : d.delete(sourceDocuments),
    );
  };

  const upsert = (source: DataSource, notes: { file: VaultFile; note: ParsedNote }[]) => {
    const indexedAt = nowIso();
    const rows = notes.map(({ file, note }) => ({
      id: docId(source.id, file.path),
      sourceId: source.id,
      path: file.path,
      title: note.title,
      aliases: note.aliases,
      tags: note.tags,
      links: note.links,
      frontmatter: note.frontmatter,
      body: note.body,
      mtime: file.mtime,
      size: file.size,
      indexedAt,
    }));
    const c = sourceDocuments;
    return rows.length
      ? q((d) =>
          d
            .insert(c)
            .values(rows)
            .onConflictDoUpdate({
              target: c.id,
              set: {
                title: excluded(c.title),
                aliases: excluded(c.aliases),
                tags: excluded(c.tags),
                links: excluded(c.links),
                frontmatter: excluded(c.frontmatter),
                body: excluded(c.body),
                mtime: excluded(c.mtime),
                size: excluded(c.size),
                indexedAt: excluded(c.indexedAt),
              },
            }),
        )
      : Effect.void;
  };

  const indexOne = (source: DataSource, force: boolean) =>
    Effect.gen(function* () {
      const started = Date.now();
      const listed = yield* fs.list(source.path);
      let skipped = 0;
      const eligible = new Map<string, VaultFile>();
      for (const f of listed) {
        if (isExcluded(f.path, source.exclude)) continue;
        if (f.size > MAX_NOTE_BYTES) skipped++;
        else eligible.set(f.path, f);
      }
      const stored = new Map(
        (yield* q((d) =>
          d
            .select({
              path: sourceDocuments.path,
              mtime: sourceDocuments.mtime,
              size: sourceDocuments.size,
            })
            .from(sourceDocuments)
            .where(eq(sourceDocuments.sourceId, source.id))
            .all(),
        )).map((r) => [r.path, r]),
      );
      const changed = [...eligible.values()].filter((f) => {
        const row = stored.get(f.path);
        return force || !row || row.mtime !== f.mtime || row.size !== f.size;
      });

      let added = 0;
      let updated = 0;
      for (const batch of chunks(changed, BATCH)) {
        const read = yield* Effect.forEach(
          batch,
          (file) =>
            fs.readText(source.path, file.path).pipe(
              Effect.flatMap((text) => Effect.try(() => parseNote(file.path, text))),
              Effect.map((note) => ({ file, note })),
              Effect.option,
            ),
          { concurrency: READ_CONCURRENCY },
        );
        const ok = read.flatMap((r) => (r._tag === "Some" ? [r.value] : []));
        skipped += batch.length - ok.length;
        for (const { file } of ok) {
          if (stored.has(file.path)) updated++;
          else added++;
        }
        yield* upsert(source, ok);
      }

      // Files gone, excluded or grown too large. A file that failed to read keeps its old row.
      const gone = [...stored.keys()].filter((p) => !eligible.has(p));
      for (const ids of chunks(
        gone.map((p) => docId(source.id, p)),
        DELETE_CHUNK,
      )) {
        yield* q((d) => d.delete(sourceDocuments).where(inArray(sourceDocuments.id, ids)));
      }

      return {
        sourceId: source.id,
        added,
        updated,
        removed: gone.length,
        unchanged: eligible.size - changed.length,
        skipped,
        durationMs: Date.now() - started,
      } satisfies IndexResult;
    });

  const index = (opts?: { sourceId?: string; force?: boolean }) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const settings = yield* settingsOrDefault(settingsSvc);
        const configured = settings.dataSources;
        yield* purgeRemoved(configured);

        let targets: DataSource[];
        if (opts?.sourceId !== undefined) {
          const one = configured.find((s) => s.id === opts.sourceId);
          if (!one) return yield* Effect.fail(notFound(`No data source "${opts.sourceId}".`));
          targets = [one];
        } else {
          targets = configured.filter((s) => s.enabled);
        }

        const status = yield* loadStatus;
        for (const id of Object.keys(status)) {
          if (!configured.some((s) => s.id === id)) delete status[id];
        }
        const results: IndexResult[] = [];
        let failure: SourceError | DbError | undefined;
        for (const source of targets) {
          const outcome = yield* Effect.either(indexOne(source, opts?.force ?? false));
          const at = nowIso();
          const prev = status[source.id];
          if (Either.isRight(outcome)) {
            results.push(outcome.right);
            status[source.id] = { lastIndexedAt: at, lastAttemptAt: at, lastError: null };
          } else {
            status[source.id] = {
              lastIndexedAt: prev?.lastIndexedAt ?? null,
              lastAttemptAt: at,
              lastError: outcome.left.message,
            };
            // One unreadable folder does not stop the others; a database failure does.
            if (opts?.sourceId !== undefined || outcome.left._tag === "DbError") {
              failure = outcome.left;
              break;
            }
          }
        }
        yield* saveStatus(status);
        if (failure) return yield* Effect.fail(failure);
        return results;
      }),
    );

  const indexIfStale = (maxAgeMs: number) =>
    Effect.gen(function* () {
      const settings = yield* settingsOrDefault(settingsSvc);
      yield* purgeRemoved(settings.dataSources);
      const enabled = settings.dataSources.filter((s) => s.enabled);
      if (enabled.length === 0) return;
      const status = yield* loadStatus;
      const now = Date.now();
      const stale = enabled.some((s) => {
        const at = status[s.id]?.lastAttemptAt ?? status[s.id]?.lastIndexedAt;
        return !at || now - Date.parse(at) >= maxAgeMs;
      });
      if (stale) yield* index();
    }).pipe(
      Effect.catchAllCause((cause) => Effect.logWarning("Indexing data sources failed", cause)),
    );

  const search = (text: string, opts?: { limit?: number; sourceId?: string }) =>
    Effect.gen(function* () {
      const limit = opts?.limit ?? DEFAULT_LIMIT;
      const settings = yield* settingsOrDefault(settingsSvc);
      const sources = settings.dataSources.filter(
        (s) => s.enabled && (opts?.sourceId === undefined || s.id === opts.sourceId),
      );
      if (limit <= 0 || sources.length === 0) return [];
      const names = new Map(sources.map((s) => [s.id, s.name]));
      const inSources = sql.join(
        sources.map((s) => sql`${s.id}`),
        sql`, `,
      );
      const run = (match: string, n: number) =>
        q((d) =>
          d.all<HitRow>(sql`SELECT d.id, d.source_id, d.path, d.title, d.tags, d.mtime,
              snippet(source_documents_fts, 3, '', '', '…', 30) AS snip, substr(d.body, 1, 1000) AS head, d.aliases
            FROM source_documents_fts JOIN ${sourceDocuments} d ON d.rowid = source_documents_fts.rowid
            WHERE source_documents_fts MATCH ${match} AND d.source_id IN (${inSources})
            ORDER BY ${BM25} LIMIT ${n}`),
        );
      // Candidates: notes with every word first, then notes with any meaningful word,
      // each in bm25 order; then notes whose title or alias carries the words go first.
      const candidates: { row: HitRow; order: number; boost: number }[] = [];
      const seen = new Set<string>();
      const words = tokens(text);
      for (const match of [ftsQuery(text), retrievalFtsQuery(text)]) {
        if (!match) continue;
        for (const row of yield* run(match, limit * CANDIDATES_PER_HIT)) {
          if (seen.has(row[0])) continue;
          seen.add(row[0]);
          const file = row[2].split("/").pop()?.replace(/\.md$/i, "") ?? "";
          const names = [row[3], file, ...readJson(row[8], StringList, [])];
          candidates.push({ row, order: candidates.length, boost: titleMatches(words, names) });
        }
      }
      const rows = candidates
        .sort((a, b) => b.boost - a.boost || a.order - b.order)
        .slice(0, limit)
        .map((c) => c.row);
      return rows.map(
        ([, sourceId, path, title, tags, mtime, snippet, head]): SearchHit => ({
          sourceId,
          sourceName: names.get(sourceId) ?? sourceId,
          path,
          title,
          tags: readJson(tags, StringList, []),
          snippet: hitSnippet(snippet, head),
          modified: iso(Number(mtime)),
        }),
      );
    });

  const read = (sourceId: string, path: string) =>
    Effect.gen(function* () {
      const settings = yield* settingsOrDefault(settingsSvc);
      const source = settings.dataSources.find((s) => s.id === sourceId && s.enabled);
      if (!source) return yield* Effect.fail(notFound(`No enabled data source "${sourceId}".`));
      const bySource = eq(sourceDocuments.sourceId, sourceId);
      let row = yield* q((d) =>
        d
          .select()
          .from(sourceDocuments)
          .where(and(bySource, eq(sourceDocuments.path, path)))
          .get(),
      );
      if (!row) {
        const keys = yield* q((d) =>
          d
            .select({
              id: sourceDocuments.id,
              path: sourceDocuments.path,
              title: sourceDocuments.title,
              aliases: sourceDocuments.aliases,
            })
            .from(sourceDocuments)
            .where(bySource)
            .all(),
        );
        const hit = resolveNote(path, keys);
        if (hit) {
          row = yield* q((d) =>
            d.select().from(sourceDocuments).where(eq(sourceDocuments.id, hit.id)).get(),
          );
        }
      }
      if (!row) return yield* Effect.fail(notFound(`No note "${path}" in ${source.name}.`));
      const doc = row;
      const others = yield* q((d) =>
        d
          .select({
            path: sourceDocuments.path,
            title: sourceDocuments.title,
            links: sourceDocuments.links,
          })
          .from(sourceDocuments)
          .where(bySource)
          .all(),
      );
      return {
        sourceId,
        sourceName: source.name,
        path: doc.path,
        title: doc.title,
        aliases: doc.aliases,
        tags: doc.tags,
        frontmatter: doc.frontmatter ?? null,
        body: doc.body,
        links: doc.links,
        backlinks: backlinks(doc, others),
        modified: iso(doc.mtime),
      };
    });

  const status = Effect.gen(function* () {
    const settings = yield* settingsOrDefault(settingsSvc);
    const counts = new Map(
      (yield* q((d) =>
        d
          .select({ sourceId: sourceDocuments.sourceId, n: count() })
          .from(sourceDocuments)
          .groupBy(sourceDocuments.sourceId)
          .all(),
      )).map((r) => [r.sourceId, r.n]),
    );
    const stored = yield* loadStatus;
    return settings.dataSources.map(
      (s): SourceStatus => ({
        sourceId: s.id,
        documents: counts.get(s.id) ?? 0,
        lastIndexedAt: stored[s.id]?.lastIndexedAt ?? null,
        lastError: stored[s.id]?.lastError ?? null,
      }),
    );
  });

  return Sources.of({ index, indexIfStale, search, read, status });
});

export const SourcesLive = Layer.effect(Sources, make);

/**
 * Full export, import and cache reset (Phase 8, design.md D27). The export holds
 * the user's own data; the Jira cache and LLM accounting are rebuilt by sync and
 * use, and secrets are never read for it.
 */
import { getTableColumns, getTableName } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { Data, Effect } from "effect";
import { z } from "zod";
import {
  actionsLog,
  communications,
  contextNotes,
  dependencies,
  followups,
  inboxItems,
  inboxMessages,
  intakeItems,
  issueMeta,
  issueNotes,
  jiraComments,
  jiraIssues,
  memories,
  people,
  proposals,
  syncState,
  teams,
} from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { query } from "@/services/db";
import { Settings } from "@/services/settings";
import { SettingsSchema } from "@/services/settings/schema";

export const EXPORT_VERSION = 1;

/** In foreign-key order: parents first. Import inserts in this order and deletes in reverse. */
export const EXPORTED_TABLES = [
  teams,
  people,
  contextNotes,
  issueMeta,
  issueNotes,
  dependencies,
  communications,
  followups,
  inboxItems,
  inboxMessages,
  intakeItems,
  proposals,
  actionsLog,
  memories,
] as const satisfies readonly SQLiteTable[];

export class TransferError extends Data.TaggedError("TransferError")<{
  readonly message: string;
}> {}

const Row = z.record(z.string(), z.unknown());
export const ExportFileSchema = z.object({
  app: z.literal("secretary"),
  version: z.literal(EXPORT_VERSION),
  exportedAt: z.string(),
  settings: SettingsSchema,
  tables: z.record(z.string(), z.array(Row)),
});
export type ExportFile = z.infer<typeof ExportFileSchema>;

export const exportAll = Effect.gen(function* () {
  const settings = yield* (yield* Settings).get;
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const table of EXPORTED_TABLES)
    tables[getTableName(table)] = yield* query((d) => d.select().from(table).all());
  return {
    app: "secretary",
    version: EXPORT_VERSION,
    exportedAt: nowIso(),
    settings,
    tables,
  } satisfies ExportFile;
});

/**
 * Checks every row against its table: only known columns, and every required
 * column present. Returns the problems, empty when the file can be imported.
 */
export function checkRows(file: ExportFile): string[] {
  const problems: string[] = [];
  const known = new Set<string>(EXPORTED_TABLES.map((t) => getTableName(t)));
  for (const name of Object.keys(file.tables))
    if (!known.has(name)) problems.push(`Unknown table "${name}".`);
  for (const table of EXPORTED_TABLES) {
    const name = getTableName(table);
    const columns = getTableColumns(table);
    const required = Object.entries(columns)
      .filter(([, c]) => c.notNull && !c.hasDefault)
      .map(([k]) => k);
    (file.tables[name] ?? []).forEach((row, i) => {
      for (const k of Object.keys(row))
        if (!(k in columns)) problems.push(`${name} row ${i + 1}: unknown field "${k}".`);
      for (const k of required)
        if (row[k] === null || row[k] === undefined)
          problems.push(`${name} row ${i + 1}: missing "${k}".`);
    });
  }
  return problems.slice(0, 20);
}

/** Parses and checks an export file without touching the database. */
export const parseExport = (text: string) =>
  Effect.gen(function* () {
    const json = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: () => new TransferError({ message: "That file is not valid JSON." }),
    });
    const parsed = ExportFileSchema.safeParse(json);
    if (!parsed.success)
      return yield* new TransferError({
        message: `That is not a Secretary export: ${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".") || "file"}: ${i.message}`)
          .join("; ")}`,
      });
    const problems = checkRows(parsed.data);
    if (problems.length)
      return yield* new TransferError({
        message: `The export has problems: ${problems.join(" ")}`,
      });
    return parsed.data;
  });

/** Replaces all exported data and settings with the file's contents. */
export const importAll = (file: ExportFile) =>
  Effect.gen(function* () {
    for (const table of [...EXPORTED_TABLES].reverse()) yield* query((d) => d.delete(table));
    for (const table of EXPORTED_TABLES) {
      const rows = file.tables[getTableName(table)] ?? [];
      // Chunks keep each statement under SQLite's parameter limit.
      for (let i = 0; i < rows.length; i += 50) {
        const chunk = rows.slice(i, i + 50) as (typeof table.$inferInsert)[];
        yield* query((d) => d.insert(table).values(chunk as never));
      }
    }
    yield* (yield* Settings).update(() => file.settings);
    return Object.fromEntries(
      EXPORTED_TABLES.map((t) => [getTableName(t), file.tables[getTableName(t)]?.length ?? 0]),
    );
  });

/** Drops the Jira cache and sync state; the next sync is a full one. */
export const resetCache = Effect.gen(function* () {
  yield* query((d) => d.delete(jiraComments));
  yield* query((d) => d.delete(jiraIssues));
  yield* query((d) => d.delete(syncState));
});

/**
 * Minimal migrator for drizzle-kit output that works without Node `fs`.
 *
 * Migration SQL is supplied by the caller (bundled by Vite in the app, read from
 * disk in tests). Each migration runs as one script inside a transaction so a
 * pooled connection cannot split it.
 */

export type Journal = {
  entries: ReadonlyArray<{ idx: number; tag: string; when: number }>;
};

export type Migration = { tag: string; statements: string[] };

export type MigrationTarget = {
  /** Runs a script that may contain several statements separated by `;`. */
  execScript: (sql: string) => Promise<void>;
  /** Returns the tags already applied. */
  appliedTags: () => Promise<string[]>;
};

export const MIGRATIONS_TABLE = "__secretary_migrations";

const CREATE_MIGRATIONS_TABLE = `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
  tag TEXT PRIMARY KEY NOT NULL,
  applied_at TEXT NOT NULL
);`;

const BREAKPOINT = "--> statement-breakpoint";

/** Orders migrations by the journal and splits each file into statements. */
export function parseMigrations(journal: Journal, files: Record<string, string>): Migration[] {
  return [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map((entry) => {
      const sql = files[entry.tag];
      if (sql === undefined) throw new Error(`Migration file missing for ${entry.tag}`);
      const statements = sql
        .split(BREAKPOINT)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return { tag: entry.tag, statements };
    });
}

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

function toScript(migration: Migration, appliedAt: string): string {
  const body = migration.statements.map((s) => (s.endsWith(";") ? s : `${s};`)).join("\n");
  return [
    "BEGIN;",
    body,
    `INSERT INTO ${MIGRATIONS_TABLE} (tag, applied_at) VALUES (${quote(migration.tag)}, ${quote(appliedAt)});`,
    "COMMIT;",
  ].join("\n");
}

/** Applies pending migrations in order. Returns the tags applied by this call. */
export async function migrate(
  target: MigrationTarget,
  migrations: Migration[],
  now: () => string = () => new Date().toISOString(),
): Promise<string[]> {
  await target.execScript(CREATE_MIGRATIONS_TABLE);
  const applied = new Set(await target.appliedTags());
  const ran: string[] = [];
  for (const migration of migrations) {
    if (applied.has(migration.tag)) continue;
    try {
      await target.execScript(toScript(migration, now()));
    } catch (error) {
      // The failed script may have left the transaction open on its connection.
      await target.execScript("ROLLBACK;").catch(() => undefined);
      throw error;
    }
    ran.push(migration.tag);
  }
  return ran;
}

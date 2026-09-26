import { appDataDir, join } from "@tauri-apps/api/path";
import Database from "@tauri-apps/plugin-sql";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { Effect, Layer } from "effect";
import { bundledMigrations } from "@/db/bundled-migrations";
import { MIGRATIONS_TABLE, migrate } from "@/db/migrator";
import * as schema from "@/db/schema";
import { logger } from "@/lib/log";
import { Db, DbError } from ".";
import { proxyCallback } from "./proxy";

const DB_FILE = "secretary.db";

const open = Effect.tryPromise({
  try: async () => {
    const location = await join(await appDataDir(), DB_FILE);
    // plugin-sql resolves relative paths against the config dir; an absolute path
    // keeps the database in appDataDir as design.md section 2 specifies.
    const sqlite = await Database.load(`sqlite:${location}`);
    const applied = await migrate(
      {
        execScript: async (sql) => {
          await sqlite.execute(sql);
        },
        appliedTags: async () =>
          (await sqlite.select<{ tag: string }[]>(`SELECT tag FROM ${MIGRATIONS_TABLE}`)).map(
            (r) => r.tag,
          ),
      },
      bundledMigrations,
    );
    if (applied.length > 0) logger.info(`Applied migrations: ${applied.join(", ")}`);
    const db = drizzle(
      proxyCallback({
        execute: (sql, params) => sqlite.execute(sql, params),
        select: (sql, params) => sqlite.select<Record<string, unknown>[]>(sql, params),
      }),
      { schema },
    );
    return { drizzle: db, location };
  },
  catch: (cause) =>
    new DbError({
      message: `Could not open the database: ${cause instanceof Error ? cause.message : String(cause)}`,
      cause,
    }),
});

export const DbLive = Layer.effect(Db, open);

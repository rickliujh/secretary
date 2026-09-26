/** In-memory database for tests: bun:sqlite behind the same proxy and migrations (D15). */
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { Effect, Layer } from "effect";
import { type Journal, MIGRATIONS_TABLE, migrate, parseMigrations } from "@/db/migrator";
import * as schema from "@/db/schema";
import { Db, DbError } from ".";
import { proxyCallback } from "./proxy";

const MIGRATIONS_DIR = join(import.meta.dir, "../../db/migrations");

export function loadMigrationsFromDisk() {
  const journal = JSON.parse(
    readFileSync(join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8"),
  ) as Journal;
  const files = Object.fromEntries(
    readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => [f.replace(/\.sql$/, ""), readFileSync(join(MIGRATIONS_DIR, f), "utf8")]),
  );
  return parseMigrations(journal, files);
}

const toParams = (params: unknown[]) =>
  params.map((p) => (typeof p === "boolean" ? Number(p) : p)) as SQLQueryBindings[];

export async function makeTestDatabase() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON;");
  // Row objects, like plugin-sql, so tests exercise the same proxy mapping.
  const select = (sql: string, params: unknown[] = []) =>
    sqlite.query(sql).all(...toParams(params)) as Record<string, unknown>[];
  await migrate(
    {
      execScript: async (sql) => {
        sqlite.run(sql);
      },
      appliedTags: async () =>
        select(`SELECT tag FROM ${MIGRATIONS_TABLE}`).map((r) => String(r.tag)),
    },
    loadMigrationsFromDisk(),
  );
  const db = drizzle(
    proxyCallback({
      execute: async (sql, params) => sqlite.query(sql).run(...toParams(params)),
      select: async (sql, params) => select(sql, params),
    }),
    { schema },
  );
  return { sqlite, drizzle: db, select };
}

export const DbTest = Layer.effect(
  Db,
  Effect.tryPromise({
    try: async () => ({ drizzle: (await makeTestDatabase()).drizzle, location: ":memory:" }),
    catch: (cause) => new DbError({ message: "test database failed", cause }),
  }),
);

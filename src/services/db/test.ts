/** In-memory database for tests: sql.js behind the same proxy and migrations. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { Effect, Layer } from "effect";
import initSqlJs from "sql.js";
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

type SqlValue = number | string | Uint8Array | null;

const toSqlParams = (params: unknown[]): SqlValue[] =>
  params.map((p) => (typeof p === "boolean" ? Number(p) : (p as SqlValue)));

export async function makeTestDatabase() {
  const SQL = await initSqlJs();
  const sqlite = new SQL.Database();
  sqlite.run("PRAGMA foreign_keys = ON;");
  const select = (sql: string, params: unknown[] = []) => {
    const stmt = sqlite.prepare(sql);
    try {
      stmt.bind(toSqlParams(params));
      const rows: Record<string, unknown>[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  };
  await migrate(
    {
      execScript: async (sql) => {
        sqlite.exec(sql);
      },
      appliedTags: async () =>
        select(`SELECT tag FROM ${MIGRATIONS_TABLE}`).map((r) => String(r.tag)),
    },
    loadMigrationsFromDisk(),
  );
  const db = drizzle(
    proxyCallback({
      execute: async (sql, params) => sqlite.run(sql, toSqlParams(params)),
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

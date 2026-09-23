import type { SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import { Context, Data, Effect } from "effect";
import type * as schema from "@/db/schema";

export type Database = SqliteRemoteDatabase<typeof schema>;

export class DbError extends Data.TaggedError("DbError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface DbShape {
  readonly drizzle: Database;
  /** Absolute path of the database file, or `:memory:`. */
  readonly location: string;
}

export class Db extends Context.Tag("Db")<Db, DbShape>() {}

const describe = (cause: unknown) =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "database error";

/** Runs a drizzle query and maps failures to `DbError`. */
export const query = <A>(f: (db: Database) => Promise<A>): Effect.Effect<A, DbError, Db> =>
  Effect.flatMap(Db, ({ drizzle }) =>
    Effect.tryPromise({
      try: () => f(drizzle),
      catch: (cause) => new DbError({ message: describe(cause), cause }),
    }),
  );

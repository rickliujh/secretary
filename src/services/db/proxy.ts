/**
 * Adapters from row-object SQL drivers to drizzle's sqlite-proxy contract,
 * which expects positional arrays (design.md D3).
 */
import type { AsyncRemoteCallback } from "drizzle-orm/sqlite-proxy";

export type RowObjectDriver = {
  execute: (sql: string, params: unknown[]) => Promise<unknown>;
  select: (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;
};

export function proxyCallback(driver: RowObjectDriver): AsyncRemoteCallback {
  return async (sql, params, method) => {
    if (method === "run") {
      await driver.execute(sql, params);
      return { rows: [] };
    }
    const rows = (await driver.select(sql, params)).map((row) => Object.values(row));
    // For `get`, drizzle expects the single row itself (or undefined).
    return { rows: method === "get" ? (rows[0] as unknown as unknown[]) : rows };
  };
}

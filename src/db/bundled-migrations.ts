/** Migrations bundled into the webview build by Vite. */

import journal from "./migrations/meta/_journal.json";
import { type Migration, parseMigrations } from "./migrator";

const files = import.meta.glob<string>("./migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

const byTag = Object.fromEntries(
  Object.entries(files).map(([path, sql]) => [path.replace(/^.*\/(.+)\.sql$/, "$1"), sql]),
);

export const bundledMigrations: Migration[] = parseMigrations(journal, byTag);

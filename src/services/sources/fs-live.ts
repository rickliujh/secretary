/**
 * `VaultFs` on the Tauri fs plugin (design.md D41). Access comes from the
 * folder dialog; the persisted-scope plugin keeps it across restarts.
 */
import { join } from "@tauri-apps/api/path";
import { readDir, readTextFile, stat } from "@tauri-apps/plugin-fs";
import { Effect, Layer } from "effect";
import { SourceError, type VaultFile, VaultFs } from ".";

/** Parallel IPC calls while walking a folder. */
const CONCURRENCY = 16;

const describe = (cause: unknown) =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "unknown error";

const noAccess = (what: string, cause: unknown) =>
  new SourceError({
    kind: "no_access",
    message: `Cannot read ${what} (${describe(cause)}). Pick the folder again in Settings > Data sources.`,
  });

/** Runs `f` over `items` with at most `limit` promises in flight. */
async function pool<T, R>(items: T[], limit: number, f: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await f(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/**
 * Every .md file under `root` with its mtime and size. Dot entries and symlinks
 * (which could loop) are skipped; an unreadable subfolder is skipped, an
 * unreadable root throws.
 */
async function walk(root: string): Promise<VaultFile[]> {
  const files: VaultFile[] = [];
  const visit = async (dir: string, rel: string, isRoot: boolean): Promise<void> => {
    let entries: Awaited<ReturnType<typeof readDir>>;
    try {
      entries = await readDir(dir);
    } catch (cause) {
      if (isRoot) throw cause;
      return;
    }
    const visible = entries.filter((e) => !e.name.startsWith(".") && !e.isSymlink);
    const notes = visible.filter((e) => e.isFile && /\.md$/i.test(e.name));
    const found = await pool(notes, CONCURRENCY, async (e) => {
      try {
        const info = await stat(await join(dir, e.name));
        return {
          path: rel ? `${rel}/${e.name}` : e.name,
          mtime: info.mtime ? info.mtime.getTime() : 0,
          size: info.size,
        };
      } catch {
        return null; // removed while listing
      }
    });
    for (const f of found) if (f) files.push(f);
    for (const d of visible.filter((e) => e.isDirectory)) {
      await visit(await join(dir, d.name), rel ? `${rel}/${d.name}` : d.name, false);
    }
  };
  await visit(root, "", true);
  return files;
}

export const VaultFsLive = Layer.succeed(
  VaultFs,
  VaultFs.of({
    list: (root) =>
      Effect.tryPromise({
        try: () => walk(root),
        catch: (cause) => noAccess(`the folder "${root}"`, cause),
      }),
    readText: (root, path) =>
      Effect.tryPromise({
        try: async () => readTextFile(await join(root, ...path.split("/"))),
        catch: (cause) => noAccess(`"${path}" in "${root}"`, cause),
      }),
  }),
);

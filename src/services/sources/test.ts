/** In-memory `VaultFs` for tests, plus a loader for the fixture vault on disk. */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect, Layer } from "effect";
import { SourceError, VaultFs } from ".";

export type MemoryFile = { text: string; mtime: number; size?: number };
/** root -> vault-relative path -> file. */
export type MemoryVaults = Record<string, Record<string, MemoryFile>>;

const byteLength = (text: string) => new TextEncoder().encode(text).length;

/**
 * A memory file system. `vaults` stays live: `write` and `remove` change it
 * between calls, a root missing from it fails like a folder that was moved,
 * and `reads` records every `readText` as "root:path".
 */
export function makeVaultFsTest(initial: MemoryVaults = {}) {
  const vaults: MemoryVaults = structuredClone(initial);
  const reads: string[] = [];
  const missing = (root: string) =>
    new SourceError({
      kind: "no_access",
      message: `Cannot read the folder "${root}". Pick the folder again in Settings > Data sources.`,
    });
  const layer = Layer.succeed(
    VaultFs,
    VaultFs.of({
      list: (root) =>
        Effect.suspend(() => {
          const files = vaults[root];
          if (!files) return Effect.fail(missing(root));
          return Effect.succeed(
            Object.entries(files)
              .filter(
                ([path]) =>
                  /\.md$/i.test(path) && !path.split("/").some((seg) => seg.startsWith(".")),
              )
              .map(([path, f]) => ({ path, mtime: f.mtime, size: f.size ?? byteLength(f.text) })),
          );
        }),
      readText: (root, path) =>
        Effect.suspend(() => {
          const file = vaults[root]?.[path];
          if (!file) return Effect.fail(missing(root));
          reads.push(`${root}:${path}`);
          return Effect.succeed(file.text);
        }),
    }),
  );
  return {
    layer,
    vaults,
    reads,
    write: (root: string, path: string, file: MemoryFile) => {
      vaults[root] ??= {};
      vaults[root][path] = file;
    },
    remove: (root: string, path: string) => {
      delete vaults[root]?.[path];
    },
    /** Makes the whole folder unreadable (moved or permission lost). */
    removeRoot: (root: string) => {
      delete vaults[root];
    },
  };
}

/** Reads a folder on disk, dot folders included, into memory files with mtime `mtime`. */
export function loadVaultFromDisk(dir: string, mtime = 1_700_000_000_000) {
  const out: Record<string, MemoryFile> = {};
  const visit = (abs: string, rel: string) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) visit(join(abs, e.name), path);
      else out[path] = { text: readFileSync(join(abs, e.name), "utf8"), mtime };
    }
  };
  visit(dir, "");
  return out;
}

export const FIXTURE_VAULT_DIR = join(import.meta.dir, "../../test/fixtures/vault");

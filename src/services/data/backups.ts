import { BaseDirectory, readDir, remove } from "@tauri-apps/plugin-fs";

/** Import writes a backup of the current data first; the newest few are kept (D34). */
export const BACKUP_PREFIX = "backup-before-import-";
export const KEEP_BACKUPS = 3;

/** Backup names past the newest `keep`; names sort by their timestamp. */
export function backupsToPrune(names: readonly string[], keep = KEEP_BACKUPS): string[] {
  return names
    .filter((n) => n.startsWith(BACKUP_PREFIX) && n.endsWith(".json"))
    .sort()
    .reverse()
    .slice(keep);
}

export async function pruneImportBackups(): Promise<number> {
  const entries = await readDir("", { baseDir: BaseDirectory.AppData });
  const old = backupsToPrune(entries.filter((e) => e.isFile).map((e) => e.name));
  for (const name of old) await remove(name, { baseDir: BaseDirectory.AppData });
  return old.length;
}

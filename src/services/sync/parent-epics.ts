/** Which parent epics a sync run reads as context (design.md D53). */
import { ISSUE_KEY_RE } from "@/services/proposals/schema";

export type EpicRef = {
  key: string;
  epicKey: string | null;
  stale: boolean;
  syncedAt: string;
};

/**
 * Epics that synced issues sit under but the sync scope left out, so the epic
 * picker, intake and reports can name and offer them. A full run counts only the
 * issues it read itself, so it reads every out-of-scope epic again and keeps its
 * name current; an incremental run reads only epics it has not stored (or that a
 * full run marked stale).
 */
export function parentEpicsToRead(
  rows: readonly EpicRef[],
  run: { full: boolean; syncedAt: string },
): string[] {
  const current = (r: EpicRef) => !r.stale && (!run.full || r.syncedAt === run.syncedAt);
  const stored = new Set(rows.filter(current).map((r) => r.key));
  const wanted = new Set<string>();
  for (const r of rows) {
    if (current(r) && r.epicKey && !stored.has(r.epicKey) && ISSUE_KEY_RE.test(r.epicKey))
      wanted.add(r.epicKey);
  }
  return [...wanted].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

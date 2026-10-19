/**
 * Issues read only as candidates (D45): a ticket the input names that the
 * cache does not hold, or what a playbook's live search found in the owner's
 * projects (FR-19.7, Phase 26). They are stored out of the sync scope
 * (`stale`), so they are offered by their key and nowhere else (no project
 * lists, tickets tree, ranking or blocker checks), and cleanup removes them.
 * An issue the cache already holds keeps its row and scope.
 */
import { inArray } from "drizzle-orm";
import { Effect } from "effect";
import { jiraIssues } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { query } from "@/services/db";
import type { RawIssue } from "@/services/jira";
import { effectiveFieldIds } from "@/services/jira/fields";
import { mapIssue } from "@/services/jira/mapping";
import { Settings, settingsOrDefault } from "@/services/settings";
import { withoutDeleted } from "./deleted";
import { getState, parseFieldIds, SYNC_KEYS } from "./state";
import { upsertIssues } from "./upsert";

/** Stores search results the cache does not hold yet as candidates; returns the keys stored. */
export const storeCandidates = (raws: readonly RawIssue[]) =>
  Effect.gen(function* () {
    if (raws.length === 0) return [] as string[];
    const settings = yield* settingsOrDefault(yield* Settings);
    const fieldIds = effectiveFieldIds(
      parseFieldIds(yield* getState(SYNC_KEYS.fields)),
      settings.jira.fields,
    );
    const syncedAt = nowIso();
    const mapped = raws.flatMap((raw) => {
      try {
        return [
          mapIssue(raw, {
            fieldIds,
            trackedEpics: new Set(settings.jira.trackedEpics),
            syncedAt,
          }).issue,
        ];
      } catch {
        return [];
      }
    });
    if (mapped.length === 0) return [];
    const cached = new Set(
      (yield* query((d) =>
        d
          .select({ key: jiraIssues.key })
          .from(jiraIssues)
          .where(
            inArray(
              jiraIssues.key,
              mapped.map((m) => m.key),
            ),
          )
          .all(),
      )).map((r) => r.key),
    );
    // A ticket a revoke deleted is never stored again (FR-14.6).
    const fresh = yield* withoutDeleted(mapped.filter((m) => !cached.has(m.key)));
    if (fresh.length === 0) return [];
    // A candidate read is no change anyone made: no work events (D61).
    yield* upsertIssues(
      fresh.map((m) => ({ ...m, stale: true })),
      "none",
    );
    return fresh.map((m) => m.key);
  });

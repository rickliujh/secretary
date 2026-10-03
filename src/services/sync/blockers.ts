/**
 * The post-sync blocker step (FR-3.8, D45). A linked issue changing does not
 * change the linking issue's `updated`, so incremental sync alone misses a
 * blocker that closed. After every sync this reads the blockers of the user's
 * open issues that the run did not return, keeps their state in `jira.blockers`,
 * and records on `issue_meta` when an issue's last open blocker closed.
 */
import { and, eq, ne, sql } from "drizzle-orm";
import { Effect, Option } from "effect";
import { z } from "zod";
import { issueMeta, jiraIssues } from "@/db/schema";
import {
  type BlockerMap,
  type BlockerState,
  blockerKeys,
  nextWakeState,
  openBlockers,
  sameWakeState,
} from "@/services/blockers/logic";
import { blockLinks } from "@/services/dashboard/sections";
import { query } from "@/services/db";
import { JiraClient, type RawIssue } from "@/services/jira";
import { jiraDateToIsoOrNull } from "@/services/jira/dates";
import { parseIssueLinks } from "@/services/jira/schemas";
import { chunk } from "./jql";
import { SYNC_KEYS, setState } from "./state";

const KEYS_PER_SEARCH = 100;
/** Blockers read one by one when a `key in (...)` search fails (a deleted or hidden key). */
const MAX_SINGLE_READS = 50;
const BLOCKER_FIELDS = ["status", "resolutiondate"];

const StatusFields = z.object({
  status: z.object({ name: z.string(), statusCategory: z.object({ key: z.string() }) }),
  resolutiondate: z.string().nullish(),
});

/** A blocker's state from a raw issue read with `status` and `resolutiondate`. */
export function blockerStateOf(raw: RawIssue): BlockerState | null {
  const f = StatusFields.safeParse(raw.fields);
  if (!f.success) return null;
  return {
    status: f.data.status.name,
    statusCategory: f.data.status.statusCategory.key,
    resolvedAt: jiraDateToIsoOrNull(f.data.resolutiondate),
  };
}

export type BlockerStepResult = { blockers: number; read: number; woke: string[] };

/**
 * Runs the step. `returned` holds the state of issues this sync run fetched, so
 * only the others are read again.
 */
export const syncBlockers = (opts: {
  me: string | null;
  returned: ReadonlyMap<string, BlockerState>;
  at: string;
}) =>
  Effect.gen(function* () {
    const jira = yield* JiraClient;
    if (!opts.me) return { blockers: 0, read: 0, woke: [] } satisfies BlockerStepResult;
    const me = opts.me;
    const rows = yield* query((d) =>
      d
        .select({
          key: jiraIssues.key,
          links: sql<string | null>`json_extract(${jiraIssues.raw}, '$.issuelinks')`,
          openBlockers: issueMeta.openBlockers,
          unblockedAt: issueMeta.unblockedAt,
          unblockedBy: issueMeta.unblockedBy,
          unblockNotifiedAt: issueMeta.unblockNotifiedAt,
        })
        .from(jiraIssues)
        .leftJoin(issueMeta, eq(issueMeta.issueKey, jiraIssues.key))
        .where(
          and(
            eq(jiraIssues.assignee, me),
            ne(jiraIssues.statusCategory, "done"),
            eq(jiraIssues.stale, false),
          ),
        )
        .all(),
    );
    const issues = rows.map((r) => ({ ...r, links: blockLinks(parseIssueLinks(r.links)) }));
    const wanted = [...new Set(issues.flatMap((i) => blockerKeys(i.links)))].sort();

    const map: BlockerMap = {};
    const missing: string[] = [];
    for (const key of wanted) {
      const s = opts.returned.get(key);
      if (s) map[key] = s;
      else missing.push(key);
    }
    let read = 0;
    for (const keys of chunk(missing, KEYS_PER_SEARCH)) {
      const found = yield* jira
        .search({
          jql: `key in (${keys.join(", ")})`,
          cursor: null,
          maxResults: KEYS_PER_SEARCH,
          fields: BLOCKER_FIELDS,
        })
        .pipe(Effect.option);
      if (Option.isSome(found)) {
        for (const raw of found.value.issues) {
          const s = blockerStateOf(raw);
          if (s && keys.includes(raw.key)) map[raw.key] = s;
        }
        read += found.value.issues.length;
        continue;
      }
      // One unknown key fails the whole search on some instances: read them singly.
      for (const key of keys.slice(0, MAX_SINGLE_READS)) {
        const raw = yield* jira.getIssue(key, { fields: BLOCKER_FIELDS }).pipe(Effect.option);
        const s = Option.isSome(raw) ? blockerStateOf(raw.value) : null;
        if (s) {
          map[key] = s;
          read += 1;
        }
      }
    }
    yield* setState(SYNC_KEYS.blockers, JSON.stringify(map));

    // Wake-up: an issue whose last open blocker closed (D45).
    const woke: string[] = [];
    for (const issue of issues) {
      const prev = {
        openBlockers: issue.openBlockers ?? null,
        unblockedAt: issue.unblockedAt ?? null,
        unblockedBy: issue.unblockedBy ?? null,
        unblockNotifiedAt: issue.unblockNotifiedAt ?? null,
      };
      // Before the first run of this step an issue without blockers needs no row.
      if (prev.openBlockers === null && blockerKeys(issue.links).length === 0) continue;
      const next = nextWakeState(prev, openBlockers(issue.links, map), map, opts.at);
      if (sameWakeState(prev, next)) continue;
      if (next.unblockedAt && next.unblockedAt !== prev.unblockedAt) woke.push(issue.key);
      yield* query((d) =>
        d
          .insert(issueMeta)
          .values({ issueKey: issue.key, ...next })
          .onConflictDoUpdate({ target: issueMeta.issueKey, set: next }),
      );
    }
    return { blockers: wanted.length, read, woke } satisfies BlockerStepResult;
  });

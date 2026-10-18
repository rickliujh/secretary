/**
 * The post-sync blocker step (FR-3.8, D45). A linked issue changing does not
 * change the linking issue's `updated`, so incremental sync alone misses a
 * blocker that closed. After every sync this reads the blockers of the user's
 * open issues that the run did not return, keeps their state in `jira.blockers`,
 * and records on `issue_meta` when an issue's last open blocker closed.
 *
 * Only a definite answer changes anything: a blocker that could not be read
 * this run keeps its last known state, and an issue with a blocker whose state
 * is unknown does not wake (review of Phase 12).
 */
import { and, eq, isNotNull, ne, notInArray, or, sql } from "drizzle-orm";
import { Effect, Either } from "effect";
import { z } from "zod";
import { issueMeta, jiraIssues } from "@/db/schema";
import {
  type BlockerMap,
  type BlockerState,
  blockerKeys,
  CLEARED_WAKE,
  decideWake,
  mergeBlockerMap,
  nextUnread,
  parseBlockers,
  parseUnreadBlockers,
  sameWakeState,
  settledBlockers,
  unreadStillValid,
  type WakeState,
} from "@/services/blockers/logic";
import { type BlockLink, blockLinks } from "@/services/dashboard/sections";
import { query } from "@/services/db";
import { JiraClient, type RawIssue, type SearchResult } from "@/services/jira";
import { jiraDateToIsoOrNull } from "@/services/jira/dates";
import { parseIssueLinks } from "@/services/jira/schemas";
import { recordEvents } from "@/services/work/events";
import { chunk } from "./jql";
import { getState, SYNC_KEYS, setState } from "./state";

const KEYS_PER_SEARCH = 100;
/** Most pages followed for one `key in (...)` search (Cloud may return fewer than asked). */
const MAX_SEARCH_PAGES = 10;
/** Most blockers read one by one in a run (moved, deleted or unreadable keys). */
const MAX_SINGLE_READS = 100;
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

/** What reading a set of blockers learned; keys in none of the three were not answered. */
export type BlockerReads = {
  read: Map<string, BlockerState>;
  /** 404: the issue does not exist any more, so the link is gone. */
  gone: Set<string>;
  /** 403: the user may not read it; its state is unknown. */
  forbidden: Set<string>;
};

/**
 * Reads blockers with `key in (...)` searches, following the next-page token.
 * A search that fails with 400 (one deleted or hidden key fails the whole
 * search on Cloud, where there is no `validateQuery: "warn"`) is split in two
 * and each half retried until the bad keys are isolated. A requested key the
 * search did not return (moved or renamed, so it came back under its new key,
 * or deleted on Data Center) is read on its own and stored under the requested
 * key. Any other failure stops reading for this run: the rest waits.
 */
export const readBlockers = (keys: readonly string[]) =>
  Effect.gen(function* () {
    const jira = yield* JiraClient;
    const out: BlockerReads = { read: new Map(), gone: new Set(), forbidden: new Set() };
    let stopped = false;
    let singles = 0;

    const single = (key: string) =>
      Effect.gen(function* () {
        if (stopped || singles >= MAX_SINGLE_READS) return;
        singles += 1;
        const r = yield* Effect.either(jira.getIssue(key, { fields: BLOCKER_FIELDS }));
        if (Either.isRight(r)) {
          const s = blockerStateOf(r.right);
          if (s) out.read.set(key, s);
          return;
        }
        if (r.left.status === 404) out.gone.add(key);
        else if (r.left.status === 403) out.forbidden.add(key);
        else stopped = true;
      });

    const search = (part: readonly string[]) =>
      Effect.gen(function* () {
        const issues: RawIssue[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
          const r: SearchResult = yield* jira.search({
            jql: `key in (${part.join(", ")})`,
            cursor,
            maxResults: KEYS_PER_SEARCH,
            fields: BLOCKER_FIELDS,
          });
          issues.push(...r.issues);
          if (!r.next || r.issues.length === 0) break;
          cursor = r.next;
        }
        return issues;
      });

    const readPart = (part: readonly string[]): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (stopped || part.length === 0) return;
        const r = yield* Effect.either(search(part));
        if (Either.isLeft(r)) {
          if (r.left.status !== 400) {
            stopped = true;
            return;
          }
          if (part.length === 1) return yield* single(part[0] ?? "");
          const mid = Math.ceil(part.length / 2);
          yield* readPart(part.slice(0, mid));
          yield* readPart(part.slice(mid));
          return;
        }
        const asked = new Set(part);
        for (const raw of r.right) {
          const s = asked.has(raw.key) ? blockerStateOf(raw) : null;
          if (s) out.read.set(raw.key, s);
        }
        for (const key of part) if (!out.read.has(key)) yield* single(key);
      });

    for (const part of chunk(keys, KEYS_PER_SEARCH)) yield* readPart(part);
    return out;
  });

type CheckedIssue = WakeState & { key: string; links: BlockLink[] };

/** The user's open issues (assigned to them, not done, in scope) with their block links. */
const loadChecked = (me: string) =>
  Effect.map(
    query((d) =>
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
        .where(checkedWhere(me))
        .all(),
    ),
    (rows): CheckedIssue[] =>
      rows.map((r) => ({
        key: r.key,
        links: blockLinks(parseIssueLinks(r.links)),
        openBlockers: r.openBlockers ?? null,
        unblockedAt: r.unblockedAt ?? null,
        unblockedBy: r.unblockedBy ?? null,
        unblockNotifiedAt: r.unblockNotifiedAt ?? null,
      })),
  );

const checkedWhere = (me: string) =>
  and(
    eq(jiraIssues.assignee, me),
    ne(jiraIssues.statusCategory, "done"),
    eq(jiraIssues.stale, false),
  );

/**
 * Wake-up (D45): an issue whose last open blocker closed. Only blockers in
 * `settled` may wake an issue; see `decideWake`. Returns the keys that woke.
 */
const applyWake = (
  issues: readonly CheckedIssue[],
  map: BlockerMap,
  settled: ReadonlySet<string>,
  at: string,
) =>
  Effect.gen(function* () {
    const woke: string[] = [];
    for (const issue of issues) {
      const prev: WakeState = {
        openBlockers: issue.openBlockers,
        unblockedAt: issue.unblockedAt,
        unblockedBy: issue.unblockedBy,
        unblockNotifiedAt: issue.unblockNotifiedAt,
      };
      // Before the first run of this step an issue without blockers needs no row.
      if (prev.openBlockers === null && blockerKeys(issue.links).length === 0) continue;
      const next = decideWake({ prev, links: issue.links, blockers: map, settled, at });
      if (!next || sameWakeState(prev, next)) continue;
      if (next.unblockedAt && next.unblockedAt !== prev.unblockedAt) woke.push(issue.key);
      yield* query((d) =>
        d
          .insert(issueMeta)
          .values({ issueKey: issue.key, ...next })
          .onConflictDoUpdate({ target: issueMeta.issueKey, set: next }),
      );
    }
    return woke;
  });

/**
 * An issue that left the user's open issues (closed, reassigned, out of scope)
 * forgets its blockers, so when it returns it counts as first seen and does not
 * wake with an old reason.
 */
const clearLeft = (me: string) =>
  query((d) =>
    d
      .update(issueMeta)
      .set(CLEARED_WAKE)
      .where(
        and(
          or(isNotNull(issueMeta.openBlockers), isNotNull(issueMeta.unblockedAt)),
          notInArray(
            issueMeta.issueKey,
            d.select({ key: jiraIssues.key }).from(jiraIssues).where(checkedWhere(me)),
          ),
        ),
      ),
  );

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
    if (!opts.me) return { blockers: 0, read: 0, woke: [] } satisfies BlockerStepResult;
    const me = opts.me;
    yield* clearLeft(me);
    const issues = yield* loadChecked(me);
    const wanted = [...new Set(issues.flatMap((i) => blockerKeys(i.links)))].sort();
    const previous = parseBlockers(yield* getState(SYNC_KEYS.blockers));
    const unread = parseUnreadBlockers(yield* getState(SYNC_KEYS.blockersUnread));

    const read = new Map<string, BlockerState>();
    const gone = new Set<string>();
    const forbidden = new Set<string>();
    const skipped = new Set<string>();
    const missing: string[] = [];
    for (const key of wanted) {
      const s = opts.returned.get(key);
      const remembered = unread[key];
      if (s) read.set(key, s);
      else if (remembered && unreadStillValid(remembered, opts.at)) {
        skipped.add(key);
        (remembered.reason === "gone" ? gone : forbidden).add(key);
      } else missing.push(key);
    }
    const fresh = yield* readBlockers(missing);
    // A blocker read here (not returned by the run, so not diffed by the upsert)
    // whose status changed is a change seen in Jira (D61), e.g. PLAT-812 closed.
    yield* recordEvents(
      [...fresh.read].flatMap(([key, s]) => {
        const was = previous[key];
        if (!was || was.status === s.status) return [];
        return [
          {
            kind: "jira_change" as const,
            actor: "sync" as const,
            issueKey: key,
            summary: `${key} moved from ${was.status} to ${s.status}`,
            data: { field: "status", from: was.status, to: s.status },
          },
        ];
      }),
    );
    for (const [k, s] of fresh.read) read.set(k, s);
    for (const k of fresh.gone) gone.add(k);
    for (const k of fresh.forbidden) forbidden.add(k);

    const map = mergeBlockerMap({ wanted, read, gone, previous });
    yield* setState(SYNC_KEYS.blockers, JSON.stringify(map));
    yield* setState(
      SYNC_KEYS.blockersUnread,
      JSON.stringify(
        nextUnread({ wanted, gone, forbidden, skipped, previous: unread, at: opts.at }),
      ),
    );

    const known = new Set([...read.keys(), ...gone]);
    const woke = yield* applyWake(
      issues,
      map,
      settledBlockers(wanted, known, map, forbidden),
      opts.at,
    );
    return { blockers: wanted.length, read: fresh.read.size, woke } satisfies BlockerStepResult;
  });

/**
 * After the app re-fetched an issue (every Executor write, D45 review): when it
 * blocks one of the user's open issues, its entry in `jira.blockers` is
 * replaced with what Jira just returned and those issues get the wake-up check,
 * so closing a blocker from the app shows at once instead of at the next sync.
 */
export const refreshBlocker = (opts: { key: string; state: BlockerState; at: string }) =>
  Effect.gen(function* () {
    const me = yield* getState(SYNC_KEYS.username);
    if (!me) return [] as string[];
    const blocked = (yield* loadChecked(me)).filter((i) => blockerKeys(i.links).includes(opts.key));
    if (blocked.length === 0) return [] as string[];
    const map = { ...parseBlockers(yield* getState(SYNC_KEYS.blockers)), [opts.key]: opts.state };
    yield* setState(SYNC_KEYS.blockers, JSON.stringify(map));
    const unread = parseUnreadBlockers(yield* getState(SYNC_KEYS.blockersUnread));
    if (unread[opts.key]) {
      delete unread[opts.key];
      yield* setState(SYNC_KEYS.blockersUnread, JSON.stringify(unread));
    }
    const forbidden = new Set(
      Object.entries(unread)
        .filter(([, u]) => u.reason === "forbidden")
        .map(([k]) => k),
    );
    const keys = [...new Set(blocked.flatMap((i) => blockerKeys(i.links)))];
    return yield* applyWake(
      blocked,
      map,
      settledBlockers(keys, new Set([opts.key]), map, forbidden),
      opts.at,
    );
  });

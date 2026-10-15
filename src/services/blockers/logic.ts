/**
 * Blockers and wake-up (FR-3.8, D45): pure rules. "Do this when X is done" is a
 * Jira "is blocked by" link; after each sync the blockers of the user's open
 * issues are read fresh, and an issue whose last open blocker closed wakes up.
 */
import { z } from "zod";
import { readJson } from "@/lib/json";
import type { BlockLink, FreshStatuses } from "@/services/dashboard/sections";
import { type IssueLinkType, IssueLinkTypeSchema } from "@/services/jira/schemas";

/** One blocker's state as the post-sync step read it (`sync_state` `jira.blockers`). */
export type BlockerState = {
  status: string;
  statusCategory: string;
  /** ISO time Jira resolved it; null while open or when unknown. */
  resolvedAt: string | null;
  /**
   * Jira says the issue does not exist (404): it was deleted, so the link is
   * gone too. Stored with the done category, so every reader treats it as not
   * blocking. Absent in maps stored before it was kept.
   */
  gone?: boolean;
};
export type BlockerMap = Record<string, BlockerState>;

const BlockerMapSchema = z.record(
  z.string(),
  z.object({
    status: z.string(),
    statusCategory: z.string(),
    resolvedAt: z.string().nullable().default(null),
    gone: z.boolean().optional(),
  }),
);

export const parseBlockers = (value: string | undefined): BlockerMap =>
  readJson(value, BlockerMapSchema, {});

/** The map entry of a blocker Jira no longer has (404). */
export const GONE_BLOCKER: BlockerState = {
  status: "Not found",
  statusCategory: "done",
  resolvedAt: null,
  gone: true,
};

/**
 * Blockers the step could not read with a definite answer, so it does not ask
 * again every sync (`sync_state` `jira.blockersUnread`): "gone" (404) or
 * "forbidden" (403, state unknown), and when that was seen.
 */
export type UnreadBlockers = Record<string, { reason: "gone" | "forbidden"; at: string }>;

const UnreadBlockersSchema = z.record(
  z.string(),
  z.object({ reason: z.enum(["gone", "forbidden"]), at: z.string() }),
);

export const parseUnreadBlockers = (value: string | undefined): UnreadBlockers =>
  readJson(value, UnreadBlockersSchema, {});

/** A blocker that was not found or not readable is asked again after this long. */
export const UNREAD_RECHECK_MS = 7 * 86_400_000;
/** Most unreadable blockers remembered. */
export const MAX_UNREAD = 500;

/** Whether an unread blocker is still remembered at `at`, so it is not read again. */
export const unreadStillValid = (entry: UnreadBlockers[string] | undefined, at: string) =>
  !!entry && Date.parse(at) - Date.parse(entry.at) < UNREAD_RECHECK_MS;

/**
 * The blocker map after a run (D45). `wanted` are the blockers of the user's
 * open issues; `read` what this run learned (search, single reads, issues the
 * sync returned); `gone` keys Jira does not have. A wanted key this run did not
 * read keeps its previous entry, so a failed or partial read changes nothing;
 * keys no longer wanted are dropped.
 */
export function mergeBlockerMap(opts: {
  wanted: readonly string[];
  read: ReadonlyMap<string, BlockerState>;
  gone: ReadonlySet<string>;
  previous: BlockerMap;
}): BlockerMap {
  const map: BlockerMap = {};
  for (const key of opts.wanted) {
    const s = opts.read.get(key) ?? (opts.gone.has(key) ? GONE_BLOCKER : opts.previous[key]);
    if (s) map[key] = s;
  }
  return map;
}

/**
 * The unread record after a run: wanted keys that answered 404 or 403 now, and
 * remembered ones not asked again yet; anything read or no longer wanted is
 * forgotten. Newest kept when over `MAX_UNREAD`.
 */
export function nextUnread(opts: {
  wanted: readonly string[];
  gone: ReadonlySet<string>;
  forbidden: ReadonlySet<string>;
  /** Keys skipped this run because they are remembered. */
  skipped: ReadonlySet<string>;
  previous: UnreadBlockers;
  at: string;
}): UnreadBlockers {
  const entries: [string, UnreadBlockers[string]][] = [];
  for (const key of opts.wanted) {
    const prev = opts.previous[key];
    if (opts.skipped.has(key) && prev) entries.push([key, prev]);
    else if (opts.gone.has(key)) entries.push([key, { reason: "gone", at: opts.at }]);
    else if (opts.forbidden.has(key)) entries.push([key, { reason: "forbidden", at: opts.at }]);
  }
  entries.sort(([, a], [, b]) => b.at.localeCompare(a.at));
  return Object.fromEntries(entries.slice(0, MAX_UNREAD));
}

/** `sync_state` `jira.linkTypes`: the instance's "blocks" link type, or null when it has none. */
export type LinkTypes = { blocks: IssueLinkType | null };

const LinkTypesSchema = z.object({ blocks: IssueLinkTypeSchema.nullable().default(null) });

export const parseLinkTypes = (value: string | undefined): LinkTypes =>
  readJson(value, LinkTypesSchema, { blocks: null });

/**
 * The link type that means "blocks": outward "blocks" with inward "is blocked
 * by" (Jira's default), else one named Blocks, else any whose words say block.
 */
export function pickBlocksType(types: readonly IssueLinkType[]): IssueLinkType | null {
  return (
    types.find((t) => /^blocks$/i.test(t.outward.trim()) && /blocked by/i.test(t.inward)) ??
    types.find((t) => /^blocks?$/i.test(t.name.trim())) ??
    types.find((t) => /block/i.test(`${t.name} ${t.inward} ${t.outward}`)) ??
    null
  );
}

/** The issues an issue is blocked by, whatever their status. */
export const blockerKeys = (links: readonly BlockLink[]) => [
  ...new Set(links.filter((l) => l.direction === "blockedBy").map((l) => l.key)),
];

/** Blockers still open: the fresh state wins over the status embedded in the link. */
export function openBlockers(links: readonly BlockLink[], fresh: FreshStatuses): string[] {
  return [
    ...new Set(
      links
        .filter((l) => l.direction === "blockedBy")
        .filter((l) => (fresh[l.key]?.statusCategory ?? l.statusCategory) !== "done")
        .map((l) => l.key),
    ),
  ];
}

/** What `issue_meta` keeps about an issue's blockers (D45). */
export type WakeState = {
  /** Open blockers at the last sync; null before the first. */
  openBlockers: string[] | null;
  unblockedAt: string | null;
  unblockedBy: string | null;
  unblockNotifiedAt: string | null;
};

/**
 * The next wake state after a sync. An issue that had open blockers and has
 * none left wakes up (`unblockedAt` now, `unblockedBy` the blocker that closed
 * last); a blocker that reopens, or a new one, puts it back to sleep.
 */
export function nextWakeState(
  prev: WakeState,
  open: readonly string[],
  blockers: BlockerMap,
  at: string,
): WakeState {
  const openBlockers = [...open].sort();
  if (open.length > 0)
    return { openBlockers, unblockedAt: null, unblockedBy: null, unblockNotifiedAt: null };
  if (prev.openBlockers?.length) {
    const closedLast = [...prev.openBlockers].sort(
      (a, b) =>
        (blockers[b]?.resolvedAt ?? "").localeCompare(blockers[a]?.resolvedAt ?? "") ||
        a.localeCompare(b),
    )[0];
    return {
      openBlockers,
      unblockedAt: at,
      unblockedBy: closedLast ?? null,
      unblockNotifiedAt: null,
    };
  }
  return { ...prev, openBlockers };
}

/**
 * The next wake state when not every blocker's state is known (D45 review).
 * `settled` are the blockers whose state can be trusted: read this run, gone,
 * or kept from an earlier read and not unreadable now. A blocker outside it
 * falls back to the status embedded in the link, which is only as fresh as the
 * issue's last fetch, so it never wakes an issue: with an unsettled blocker and
 * no settled open one, the state stays as it was (null). A settled open blocker
 * puts the issue to sleep as usual.
 */
export function decideWake(opts: {
  prev: WakeState;
  links: readonly BlockLink[];
  blockers: BlockerMap;
  settled: ReadonlySet<string>;
  at: string;
}): WakeState | null {
  const open = openBlockers(opts.links, opts.blockers);
  const unsettled = blockerKeys(opts.links).filter((k) => !opts.settled.has(k));
  if (unsettled.length > 0 && !open.some((k) => opts.settled.has(k))) return null;
  return nextWakeState(opts.prev, open, opts.blockers, opts.at);
}

/**
 * Blockers whose state the wake-up may trust: those `known` this run (read,
 * returned by the sync, gone) and those with a stored entry that are not
 * unreadable (`forbidden`) now.
 */
export function settledBlockers(
  keys: readonly string[],
  known: ReadonlySet<string>,
  blockers: BlockerMap,
  forbidden: ReadonlySet<string>,
): Set<string> {
  return new Set(keys.filter((k) => known.has(k) || (!!blockers[k] && !forbidden.has(k))));
}

/** The wake state of an issue that is not one of the user's open issues: first seen when it returns. */
export const CLEARED_WAKE: WakeState = {
  openBlockers: null,
  unblockedAt: null,
  unblockedBy: null,
  unblockNotifiedAt: null,
};

export const sameWakeState = (a: WakeState, b: WakeState) =>
  JSON.stringify(a.openBlockers) === JSON.stringify(b.openBlockers) &&
  a.unblockedAt === b.unblockedAt &&
  a.unblockedBy === b.unblockedBy &&
  a.unblockNotifiedAt === b.unblockNotifiedAt;

/** "2 Oct" in the user's locale order, from an ISO time. */
const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/** Why an issue woke up: "PLAT-812 moved to Done on 2 Oct", or that the link is gone. */
export function unblockReason(blocker: string | null, blockers: BlockerMap): string {
  if (!blocker) return "Its blockers are done";
  const s = blockers[blocker];
  if (s?.statusCategory !== "done" || s.gone) return `${blocker} no longer blocks it`;
  return `${blocker} moved to ${s.status}${s.resolvedAt ? ` on ${shortDate(s.resolvedAt)}` : ""}`;
}

/** A woken ticket stays on Today at most this long (D45). */
export const WOKEN_DAYS = 7;

export type WokenRow = {
  key: string;
  summary: string;
  statusCategory: string;
  unblockedAt: string | null;
  unblockedBy: string | null;
  unblockNotifiedAt: string | null;
  lastViewedAt: string | null;
  snoozedUntil: string | null;
};

export type WokenTicket = {
  key: string;
  summary: string;
  unblockedAt: string;
  unblockedBy: string | null;
  /** "PLAT-812 moved to Done on 2 Oct". */
  reason: string;
  /** Whether the OS notification for it was sent. */
  notified: boolean;
};

/**
 * Tickets that woke up and still deserve a place first on Today (D45, D49):
 * open, woken in the last seven days, not viewed since and not snoozed. Newest first.
 */
export function wokenTickets(
  rows: readonly WokenRow[],
  blockers: BlockerMap,
  now: Date,
): WokenTicket[] {
  const nowIso = now.toISOString();
  const since = new Date(now.getTime() - WOKEN_DAYS * 86_400_000).toISOString();
  return rows
    .filter(
      (r): r is WokenRow & { unblockedAt: string } =>
        !!r.unblockedAt &&
        r.unblockedAt >= since &&
        r.statusCategory !== "done" &&
        !(r.lastViewedAt && r.lastViewedAt >= r.unblockedAt) &&
        !(r.snoozedUntil && r.snoozedUntil > nowIso),
    )
    .sort((a, b) => b.unblockedAt.localeCompare(a.unblockedAt) || a.key.localeCompare(b.key))
    .map((r) => ({
      key: r.key,
      summary: r.summary,
      unblockedAt: r.unblockedAt,
      unblockedBy: r.unblockedBy,
      reason: unblockReason(r.unblockedBy, blockers),
      notified: !!r.unblockNotifiedAt,
    }));
}

/**
 * Grouping the user's active tickets into work items (FR-19.1, D61). Pure: a
 * union-find over the active tickets and the open blockers they wait on.
 *
 * - Active: assigned to the user and in progress or in an active sprint; an
 *   open small ask; any open ticket a proposal or the ticket view acted on in
 *   the last 30 days. Epics are containers, never members.
 * - Strong edges join on their own: sub-task and parent; a "blocks" or
 *   "relates" link between two active tickets, and an active ticket and an open
 *   blocker it waits on; tickets named together in one intake item; open waits
 *   with the same owner on tickets of the same epic.
 * - Weak edges need two signals between the same two tickets: the same epic,
 *   the same requester, a shared word stem in the summaries.
 * - Stability: a ticket already in an item stays there, two existing items are
 *   never merged by code (a strong edge between them is a doubt to ask about),
 *   and new tickets join or start items. A union that would pass the cap is not
 *   made and is a doubt too. The user's corrections win: "together" joins
 *   first, "apart" is never joined.
 */
import { blockLinks, type FreshStatuses } from "@/services/dashboard/sections";
import type { IssueLink } from "@/services/jira/schemas";

export type GroupTicket = {
  key: string;
  summary: string;
  issueType: string;
  isSubtask: boolean;
  statusCategory: "new" | "indeterminate" | "done";
  assignee: string | null;
  parentKey: string | null;
  epicKey: string | null;
  /** The name of the ticket's epic, when the cache knows it. */
  epicName: string | null;
  sprint: string | null;
  labels: readonly string[];
  links: readonly IssueLink[];
  requesterId: string | null;
  /** Out of the sync scope (a candidate read): never active by itself. */
  stale: boolean;
};

export type Member = {
  itemId: string;
  role: "primary" | "related";
  addedBy: "code" | "user" | "answer";
};

export type GroupInput = {
  me: string | null;
  activeSprints: ReadonlySet<string>;
  smallAskLabel: string | null;
  tickets: readonly GroupTicket[];
  /** Open tickets a proposal or the user acted on in the last 30 days. */
  actedOn: ReadonlySet<string>;
  /** Keys named together in one intake item or chat request. */
  namedTogether: readonly (readonly string[])[];
  /** Open waits: the ticket and an owner id ("person:..." or "team:..."). */
  waits: readonly { issueKey: string; owner: string | null }[];
  /** Blocker states read after sync (D45). */
  blockers?: FreshStatuses;
  /** Where each ticket is now. */
  members: ReadonlyMap<string, Member>;
  /** Items that are active; new tickets join only these. */
  activeItems: ReadonlySet<string>;
  corrections: Corrections;
  cap: number;
};

export type Corrections = {
  together: readonly (readonly string[])[];
  apart: readonly { keys: readonly string[]; from: readonly string[] }[];
};

export type NewGroup = {
  /** Tickets in order: primary first. */
  keys: { key: string; role: "primary" | "related" }[];
  name: string;
};

/** Two groups an edge links that were not joined: by the cap, or both being items. */
export type Doubt = {
  reason: "cap" | "items";
  /** A ticket of each side; the apply step maps them to items. */
  a: string;
  b: string;
};

export type GroupResult = {
  active: ReadonlySet<string>;
  /** New tickets of existing items. */
  joins: { key: string; itemId: string; role: "primary" | "related" }[];
  created: NewGroup[];
  doubts: Doubt[];
};

const STOP = new Set(
  `about above after again against also before being below between both could does doing down during each from further have having here into itself just more most other over same should some such than that their them then there these they this those through under until very were what when where which while with would your
   update create support adding remove issue ticket task story tasks stories item items need needs make page work test tests check new fix fixes bug bugs add`
    .split(/\s+/)
    .filter(Boolean),
);

/** Lower-case word stems of a summary, for the weak "shared word" signal. */
export function stems(summary: string): Set<string> {
  const out = new Set<string>();
  for (const raw of summary.toLowerCase().match(/\p{L}[\p{L}\d]*/gu) ?? []) {
    if (raw.length < 4 || STOP.has(raw)) continue;
    const stem = raw
      .replace(/ies$/u, "y")
      .replace(/(ings?|ed|es|s)$/u, "")
      .replace(/e$/u, "");
    if (stem.length >= 4 && !STOP.has(stem)) out.add(stem);
  }
  return out;
}

const keyOrder = (a: string, b: string) => {
  const [pa, na] = [a.replace(/-\d+$/, ""), Number(a.split("-").at(-1))];
  const [pb, nb] = [b.replace(/-\d+$/, ""), Number(b.split("-").at(-1))];
  return pa.localeCompare(pb) || na - nb;
};

const isEpic = (t: GroupTicket) => /^epic$/i.test(t.issueType);
const isRelates = (l: IssueLink) =>
  /relat/i.test(`${l.type.name} ${l.type.inward} ${l.type.outward}`);

/** Whether a ticket is active for the user (D61). */
export function isActive(
  t: GroupTicket,
  input: Pick<GroupInput, "me" | "activeSprints" | "smallAskLabel" | "actedOn">,
) {
  if (t.stale || isEpic(t) || t.statusCategory === "done") return false;
  const mine = !!input.me && t.assignee === input.me;
  if (
    mine &&
    (t.statusCategory === "indeterminate" || (!!t.sprint && input.activeSprints.has(t.sprint)))
  )
    return true;
  const label = input.smallAskLabel?.toLowerCase();
  if (label && t.labels.some((l) => l.toLowerCase() === label) && (mine || !t.assignee))
    return true;
  return input.actedOn.has(t.key);
}

class UnionFind {
  private parent = new Map<string, string>();
  readonly members = new Map<string, string[]>();
  add(k: string) {
    if (this.parent.has(k)) return;
    this.parent.set(k, k);
    this.members.set(k, [k]);
  }
  find(k: string): string {
    let r = k;
    while (this.parent.get(r) !== r) r = this.parent.get(r) ?? r;
    let c = k;
    while (c !== r) {
      const next = this.parent.get(c) ?? r;
      this.parent.set(c, r);
      c = next;
    }
    return r;
  }
  /** Joins two roots; the smaller key stays the root, so results do not depend on order. */
  union(a: string, b: string) {
    const [root, child] = keyOrder(a, b) <= 0 ? [a, b] : [b, a];
    this.parent.set(child, root);
    this.members.set(root, [...(this.members.get(root) ?? []), ...(this.members.get(child) ?? [])]);
    this.members.delete(child);
  }
}

export function groupWork(input: GroupInput): GroupResult {
  const byKey = new Map(input.tickets.map((t) => [t.key, t]));
  const active = new Set(input.tickets.filter((t) => isActive(t, input)).map((t) => t.key));
  const fresh = input.blockers ?? {};

  // Nodes: active tickets, members of active items, and the open blockers of active tickets.
  const nodes = new Set<string>(active);
  for (const [key, m] of input.members) if (input.activeItems.has(m.itemId)) nodes.add(key);
  const related = new Set<string>();
  const strong: [string, string][] = [];
  for (const key of active) {
    const t = byKey.get(key);
    if (!t) continue;
    for (const b of blockLinks(t.links as IssueLink[])) {
      if (b.direction !== "blockedBy") continue;
      const category = fresh[b.key]?.statusCategory ?? b.statusCategory;
      if (category === "done" || active.has(b.key)) continue;
      const other = byKey.get(b.key);
      if (other && isEpic(other)) continue;
      related.add(b.key);
      nodes.add(b.key);
      strong.push([key, b.key]);
    }
  }

  // Strong edges between nodes.
  for (const key of nodes) {
    const t = byKey.get(key);
    if (!t) continue;
    if (t.isSubtask && t.parentKey && nodes.has(t.parentKey)) strong.push([key, t.parentKey]);
    if (!active.has(key)) continue;
    for (const b of blockLinks(t.links as IssueLink[]))
      if (active.has(b.key)) strong.push([key, b.key]);
    for (const l of t.links) {
      const other = (l.outwardIssue ?? l.inwardIssue)?.key;
      if (other && isRelates(l) && active.has(other)) strong.push([key, other]);
    }
  }
  for (const set of input.namedTogether) {
    const inSet = [...new Set(set)].filter((k) => nodes.has(k)).sort(keyOrder);
    for (const k of inSet.slice(1)) strong.push([inSet[0] ?? k, k]);
  }
  const byOwnerEpic = new Map<string, string[]>();
  for (const w of input.waits) {
    const epic = byKey.get(w.issueKey)?.epicKey;
    if (!w.owner || !epic || !nodes.has(w.issueKey)) continue;
    const k = `${w.owner}|${epic}`;
    byOwnerEpic.set(k, [...(byOwnerEpic.get(k) ?? []), w.issueKey]);
  }
  for (const keys of byOwnerEpic.values()) {
    const sorted = [...new Set(keys)].sort(keyOrder);
    for (const k of sorted.slice(1)) strong.push([sorted[0] ?? k, k]);
  }

  // Weak edges: two signals between the same pair of active tickets.
  const weak: [string, string][] = [];
  const act = [...active].sort(keyOrder);
  const stemOf = new Map(act.map((k) => [k, stems(byKey.get(k)?.summary ?? "")]));
  for (let i = 0; i < act.length; i++) {
    for (let j = i + 1; j < act.length; j++) {
      const a = byKey.get(act[i] ?? "");
      const b = byKey.get(act[j] ?? "");
      if (!a || !b) continue;
      let signals = 0;
      if (a.epicKey && a.epicKey === b.epicKey) signals++;
      if (a.requesterId && a.requesterId === b.requesterId) signals++;
      const sb = stemOf.get(b.key) ?? new Set<string>();
      if ([...(stemOf.get(a.key) ?? [])].some((s) => sb.has(s))) signals++;
      if (signals >= 2) weak.push([a.key, b.key]);
    }
  }

  const uf = new UnionFind();
  for (const k of [...nodes].sort(keyOrder)) uf.add(k);
  const itemOfRoot = new Map<string, string>();
  // Members of one existing item start together.
  const byItem = new Map<string, string[]>();
  for (const [key, m] of input.members)
    if (nodes.has(key) && input.activeItems.has(m.itemId))
      byItem.set(m.itemId, [...(byItem.get(m.itemId) ?? []), key]);
  for (const [itemId, keys] of [...byItem].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = keys.sort(keyOrder);
    for (const k of sorted.slice(1)) {
      const [ra, rb] = [uf.find(sorted[0] ?? k), uf.find(k)];
      if (ra !== rb) uf.union(ra, rb);
    }
    itemOfRoot.set(uf.find(sorted[0] ?? ""), itemId);
  }
  const itemOf = (root: string) => itemOfRoot.get(root) ?? null;

  const apartAcross = (a: readonly string[], b: readonly string[]) => {
    const sa = new Set(a);
    const sb = new Set(b);
    return input.corrections.apart.some(
      (c) =>
        (c.keys.some((k) => sa.has(k)) && c.from.some((k) => sb.has(k))) ||
        (c.keys.some((k) => sb.has(k)) && c.from.some((k) => sa.has(k))),
    );
  };

  const doubts = new Map<string, Doubt>();
  const join = (a: string, b: string, kind: "together" | "strong" | "weak") => {
    if (!nodes.has(a) || !nodes.has(b)) return;
    const ra = uf.find(a);
    const rb = uf.find(b);
    if (ra === rb) return;
    const ia = itemOf(ra);
    const ib = itemOf(rb);
    const ma = uf.members.get(ra) ?? [];
    const mb = uf.members.get(rb) ?? [];
    const doubt = (reason: Doubt["reason"]) => {
      const [x, y] = [ma[0] ?? a, mb[0] ?? b].sort(keyOrder) as [string, string];
      const id = `${x}|${y}`;
      if (!doubts.has(id)) doubts.set(id, { reason, a: x, b: y });
    };
    // The user said these are separate: never joined, never asked about again.
    if (kind !== "together" && apartAcross(ma, mb)) return;
    if (ia && ib && ia !== ib) {
      if (kind === "strong") doubt("items");
      return;
    }
    if (kind !== "together" && ma.length + mb.length > input.cap) {
      doubt("cap");
      return;
    }
    uf.union(ra, rb);
    const root = uf.find(ra);
    const item = ia ?? ib;
    itemOfRoot.delete(ra);
    itemOfRoot.delete(rb);
    if (item) itemOfRoot.set(root, item);
  };

  const sortPairs = (pairs: [string, string][]) =>
    pairs
      .map(([a, b]) => (keyOrder(a, b) <= 0 ? [a, b] : [b, a]) as [string, string])
      .sort((x, y) => keyOrder(x[0], y[0]) || keyOrder(x[1], y[1]));
  for (const set of input.corrections.together) {
    const inSet = [...set].filter((k) => nodes.has(k)).sort(keyOrder);
    for (const k of inSet.slice(1)) join(inSet[0] ?? k, k, "together");
  }
  for (const [a, b] of sortPairs(strong)) join(a, b, "strong");
  for (const [a, b] of sortPairs(weak)) join(a, b, "weak");

  const joins: GroupResult["joins"] = [];
  const created: NewGroup[] = [];
  const roleOf = (k: string): "primary" | "related" => (active.has(k) ? "primary" : "related");
  for (const [root, keys] of [...uf.members].sort(([a], [b]) => keyOrder(a, b))) {
    const newKeys = keys.filter((k) => !input.members.has(k)).sort(keyOrder);
    const item = itemOf(root);
    if (item) {
      for (const k of newKeys) joins.push({ key: k, itemId: item, role: roleOf(k) });
      continue;
    }
    const primaries = newKeys.filter((k) => active.has(k));
    if (primaries.length === 0) continue;
    const primary = pickPrimary(primaries.map((k) => byKey.get(k)).filter((t) => !!t));
    const ordered = [
      primary?.key ?? primaries[0] ?? "",
      ...newKeys.filter((k) => k !== primary?.key),
    ];
    created.push({
      keys: ordered.map((key) => ({ key, role: roleOf(key) })),
      name: nameFor(
        primaries.map((k) => byKey.get(k)).filter((t) => !!t),
        primary,
        byKey,
      ),
    });
  }
  return { active, joins, created, doubts: [...doubts.values()] };
}

/** The ticket an item is named after: in progress first, then the lowest key. */
function pickPrimary(tickets: readonly GroupTicket[]): GroupTicket | undefined {
  return [...tickets].sort(
    (a, b) =>
      Number(b.statusCategory === "indeterminate") - Number(a.statusCategory === "indeterminate") ||
      Number(a.isSubtask) - Number(b.isSubtask) ||
      keyOrder(a.key, b.key),
  )[0];
}

/** The epic's name when every primary ticket is in the same epic, else the primary ticket's summary. */
export function nameFor(
  tickets: readonly GroupTicket[],
  primary: GroupTicket | undefined,
  byKey: ReadonlyMap<string, GroupTicket>,
): string {
  // A sub-task sits under its parent, not the epic: it says nothing about the name.
  const stories = tickets.filter((t) => !t.isSubtask);
  const epics = new Set(stories.map((t) => t.epicKey));
  const epic = epics.size === 1 ? [...epics][0] : null;
  if (epic && stories.length > 1) {
    const name = tickets.find((t) => t.epicName)?.epicName ?? byKey.get(epic)?.summary;
    if (name) return name;
  }
  return primary?.summary ?? tickets[0]?.summary ?? "Work item";
}

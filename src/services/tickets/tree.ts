/**
 * Pure tree building for the ticket browser: Epic -> Story/Task -> Sub-task
 * (FR-1.5). Filters keep the ancestors of matching issues so context stays
 * visible.
 */

export type TicketRow = {
  key: string;
  projectKey: string;
  issueType: string;
  isSubtask: boolean;
  summary: string;
  status: string;
  statusCategory: "new" | "indeterminate" | "done";
  priority: string | null;
  assignee: string | null;
  assigneeDisplay: string | null;
  parentKey: string | null;
  epicKey: string | null;
  epicName: string | null;
  dueDate: string | null;
  updated: string;
  isTrackedEpic: boolean;
  stale: boolean;
};

export type TicketNode = TicketRow & {
  children: TicketNode[];
  /** False for ancestors shown only because a descendant matched. */
  matched: boolean;
};

export type TicketFilters = {
  /** Keys matched by full-text search; null when there is no text query. */
  textMatches: ReadonlySet<string> | null;
  statusCategories: ReadonlySet<TicketRow["statusCategory"]>;
  /** Username, or "unassigned". Null means any. */
  assignee: string | null;
  project: string | null;
  showStale: boolean;
};

export const ALL_CATEGORIES: ReadonlySet<TicketRow["statusCategory"]> = new Set([
  "new",
  "indeterminate",
  "done",
]);

export const isFiltering = (f: TicketFilters) =>
  f.textMatches !== null ||
  f.statusCategories.size < 3 ||
  f.assignee !== null ||
  f.project !== null;

const isEpic = (r: TicketRow) => r.issueType === "Epic";

const keyNumber = (key: string) => Number(key.slice(key.lastIndexOf("-") + 1)) || 0;

const byKey = (a: TicketRow, b: TicketRow) =>
  a.projectKey === b.projectKey
    ? keyNumber(a.key) - keyNumber(b.key)
    : a.projectKey.localeCompare(b.projectKey);

function matches(r: TicketRow, f: TicketFilters): boolean {
  if (f.textMatches && !f.textMatches.has(r.key)) return false;
  if (!f.statusCategories.has(r.statusCategory)) return false;
  if (
    f.assignee === "unassigned"
      ? r.assignee !== null
      : f.assignee !== null && r.assignee !== f.assignee
  )
    return false;
  if (f.project !== null && r.projectKey !== f.project) return false;
  return true;
}

/** Key of the node this row hangs under, if that node is present. */
function parentOf(r: TicketRow, present: ReadonlyMap<string, TicketRow>): string | null {
  if (r.parentKey && present.has(r.parentKey)) return r.parentKey;
  if (!isEpic(r) && r.epicKey && present.has(r.epicKey)) return r.epicKey;
  return null;
}

export function buildTree(rows: readonly TicketRow[], filters: TicketFilters): TicketNode[] {
  const present = new Map<string, TicketRow>();
  for (const r of rows) if (filters.showStale || !r.stale) present.set(r.key, r);

  const filtering = isFiltering(filters);
  const visible = new Map<string, boolean>(); // key -> matched
  for (const r of present.values()) {
    if (filtering && !matches(r, filters)) continue;
    visible.set(r.key, true);
    // Walk up so ancestors stay visible as context.
    let up = parentOf(r, present);
    const guard = new Set([r.key]);
    while (up && !guard.has(up)) {
      guard.add(up);
      if (!visible.has(up)) visible.set(up, false);
      const row = present.get(up);
      up = row ? parentOf(row, present) : null;
    }
  }

  const nodes = new Map<string, TicketNode>();
  for (const [key, matched] of visible) {
    const row = present.get(key);
    if (row) nodes.set(key, { ...row, children: [], matched });
  }
  const roots: TicketNode[] = [];
  for (const node of nodes.values()) {
    const parent = parentOf(node, present);
    const parentNode = parent ? nodes.get(parent) : undefined;
    if (parentNode) parentNode.children.push(node);
    else roots.push(node);
  }
  const sortChildren = (list: TicketNode[]) => {
    list.sort(byKey);
    for (const n of list) if (n.children.length) sortChildren(n.children);
  };
  for (const n of nodes.values()) if (n.children.length) sortChildren(n.children);

  const rank = (n: TicketNode) => (n.isTrackedEpic ? 0 : isEpic(n) ? 1 : 2);
  return roots.sort(
    (a, b) =>
      rank(a) - rank(b) || (rank(a) === 2 ? b.updated.localeCompare(a.updated) : byKey(a, b)),
  );
}

/** Converts free text into an FTS5 prefix query of quoted tokens, or null. */
export function ftsQuery(text: string): string | null {
  const tokens = text
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length > 0)
    .slice(0, 12);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replaceAll('"', '""')}"*`).join(" ");
}

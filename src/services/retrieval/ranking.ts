/** Pure ranking and query helpers for retrieval (design.md 7.3 step 3). */

const STOPWORDS = new Set(
  "a an and are as at be been but by can could do does for from had has have hi hello i if in into is it its just me my no not of on or our please so some than that the their them then there these they this to too up us was we were what when which who will with would you your can't don't i'm it's let's thanks thank also still any get got need needs".split(
    " ",
  ),
);

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

/** OR of distinct meaningful tokens as prefix queries, for bm25 ranking. Null if nothing is left. */
export function retrievalFtsQuery(text: string, max = 16): string | null {
  const unique = [...new Set(tokens(text))].slice(0, max);
  if (unique.length === 0) return null;
  return unique.map((t) => `"${t.replaceAll('"', '""')}"*`).join(" OR ");
}

export type Reason = "mentioned" | "search" | "recent" | "sender" | "epic" | "tracked";

/**
 * Merges candidate sources in priority order, keeping each key once with all
 * its reasons. Explicit mentions always survive the limit.
 */
export function mergeCandidates(
  sources: [Reason, readonly string[]][],
  limit: number,
): Map<string, Reason[]> {
  const out = new Map<string, Reason[]>();
  for (const [reason, keys] of sources) {
    for (const key of keys) {
      const existing = out.get(key);
      if (existing) {
        if (!existing.includes(reason)) existing.push(reason);
      } else if (out.size < limit || reason === "mentioned") {
        out.set(key, [reason]);
      }
    }
  }
  return out;
}

/** Jaccard overlap of meaningful tokens. */
export function overlap(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

type Rankable = { text: string; weight?: number; at?: string | null };

/** Scores by overlap with the input, weight and recency; most relevant first. */
export function rankByRelevance<T extends Rankable>(
  items: readonly T[],
  input: string,
  limit: number,
  now = Date.now(),
): T[] {
  const score = (t: T) => {
    const days = t.at ? Math.max(0, (now - new Date(t.at).getTime()) / 86_400_000) : 365;
    const recency = 1 / (1 + days / 30);
    return overlap(t.text, input) * 3 + (t.weight ?? 1) * 0.2 + recency * 0.5;
  };
  return [...items]
    .map((t) => ({ t, s: score(t) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.t);
}

const PRIORITY_ORDER = [
  "Blocker",
  "Highest",
  "Critical",
  "High",
  "Major",
  "Medium",
  "Minor",
  "Low",
  "Lowest",
  "Trivial",
];

export function orderPriorities(names: readonly string[]): string[] {
  const rank = (n: string) => {
    const i = PRIORITY_ORDER.indexOf(n);
    return i === -1 ? PRIORITY_ORDER.length : i;
  };
  return [...new Set(names)].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

export type RankableMemory = Rankable & {
  subjectType: string | null;
  subjectId: string | null;
  useCount?: number;
};

/**
 * Memories for one prompt (design.md D26): overlap with the input, a boost when
 * the memory is about something in the item (an issue, the sender, a contact or
 * a team), then weight, recency and how often it has been useful.
 */
export function rankMemories<T extends RankableMemory>(
  items: readonly T[],
  input: string,
  subjects: ReadonlySet<string>,
  limit: number,
  now = Date.now(),
): T[] {
  const score = (t: T) => {
    const days = t.at ? Math.max(0, (now - new Date(t.at).getTime()) / 86_400_000) : 365;
    const about =
      t.subjectType && t.subjectId ? subjects.has(`${t.subjectType}:${t.subjectId}`) : false;
    return (
      overlap(t.text, input) * 3 +
      (about ? 2 : 0) +
      (t.weight ?? 1) * 0.3 +
      (1 / (1 + days / 30)) * 0.5 +
      Math.min(t.useCount ?? 0, 10) * 0.03
    );
  };
  return [...items]
    .map((t) => ({ t, s: score(t) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.t);
}

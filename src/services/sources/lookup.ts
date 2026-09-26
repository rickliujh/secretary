/** Pure note lookup for data sources (design.md D41): wikilink-style resolution and backlinks. */

export type NoteKey = { path: string; title: string; aliases: string[] };

const withoutMd = (path: string) => path.replace(/\.md$/i, "");
const baseName = (path: string) => withoutMd(path.split("/").pop() ?? path);

/**
 * A lookup key from a path, title, alias or wikilink as the user or model wrote
 * it: "[[Projects/Ledger export#Decisions|x]]" -> "projects/ledger export".
 */
export function normalizeTarget(input: string): string {
  return withoutMd(
    input
      .trim()
      .replace(/^!?\[\[/, "")
      .replace(/\]\]$/, "")
      .split("|")[0]
      .split("#")[0]
      .split("^")[0]
      .trim()
      .replaceAll("\\", "/")
      .replace(/^(\.\/)+/, "")
      .replace(/^\/+/, ""),
  ).toLowerCase();
}

/**
 * The note `target` names, as Obsidian resolves a link: full path, then file
 * name (shortest path wins), then title, then alias. Case-insensitive.
 */
export function resolveNote<T extends NoteKey>(target: string, notes: readonly T[]): T | null {
  const t = normalizeTarget(target);
  if (!t) return null;
  const byPath = (a: T, b: T) => a.path.length - b.path.length || a.path.localeCompare(b.path);
  const first = (pred: (n: T) => boolean) => notes.filter(pred).sort(byPath)[0] ?? null;
  return (
    first((n) => withoutMd(n.path).toLowerCase() === t) ??
    first((n) => baseName(n.path).toLowerCase() === t) ??
    first((n) => n.title.toLowerCase() === t) ??
    first((n) => n.aliases.some((a) => a.toLowerCase() === t))
  );
}

/** Every name a link to `note` can use: path without .md, file name, title, aliases (lower-cased). */
export function linkNames(note: NoteKey): Set<string> {
  return new Set(
    [withoutMd(note.path), baseName(note.path), note.title, ...note.aliases].map((n) =>
      n.toLowerCase(),
    ),
  );
}

/** Titles of `others` that link to `note`, in their given order, without `note` itself. */
export function backlinks(
  note: NoteKey,
  others: readonly { path: string; title: string; links: readonly string[] }[],
): string[] {
  const names = linkNames(note);
  const out = others
    .filter((o) => o.path !== note.path && o.links.some((l) => names.has(l.toLowerCase())))
    .map((o) => o.title);
  return [...new Set(out)];
}

const EXCERPT_CHARS = 240;

/**
 * One-line excerpt for a search hit: the FTS snippet when it has text, else the
 * start of the body, whitespace collapsed and clipped with "…".
 */
export function hitSnippet(snippet: string | null | undefined, body: string): string {
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();
  const s = flat(snippet ?? "");
  if (s.replaceAll("…", "").trim()) return s;
  const b = flat(body);
  return b.length > EXCERPT_CHARS ? `${b.slice(0, EXCERPT_CHARS).trimEnd()}…` : b;
}

/**
 * How many of the query's words start a word of the note's title, aliases or
 * file name. Search sorts by this first: in a vault where a word is in most
 * notes, FTS5's bm25 gives a title match almost no weight.
 */
export function titleMatches(queryWords: readonly string[], names: readonly string[]): number {
  const words = new Set(
    names
      .flatMap((n) =>
        n
          .toLowerCase()
          .normalize("NFKC")
          .split(/[^\p{L}\p{N}_]+/u),
      )
      .filter(Boolean),
  );
  return queryWords.filter((q) => [...words].some((w) => w.startsWith(q.toLowerCase()))).length;
}

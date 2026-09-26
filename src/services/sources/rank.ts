/**
 * Search on top of the Obsidian CLI (D41): Obsidian finds the matching lines in
 * vault order; code builds the queries and ranks the files.
 */
import { tokens } from "@/services/retrieval/ranking";
import type { CliSearchResult } from "./cli-output";

const SNIPPET_LINES = 3;
const SNIPPET_CHARS = 300;
/** More matching lines stop counting after this, so long logs do not win on volume. */
const LINE_CAP = 10;

/** Question words that would make an every-word search miss. */
const QUESTION = new Set(
  "how what when where who whom whose why which did does do done can could should would will we our ours you your me my mine tell show find about notes note know".split(
    " ",
  ),
);

/** Words to search for: meaningful tokens, or every word when none are left. */
export function queryWords(text: string): string[] {
  const words = [...new Set(tokens(text))].filter((w) => !QUESTION.has(w));
  if (words.length) return words;
  return [
    ...new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}_]+/u)
        .filter(Boolean),
    ),
  ];
}

/** An Obsidian search term: quoted when it holds anything but letters and digits. */
const term = (w: string) => (/^[\p{L}\p{N}_]+$/u.test(w) ? w : `"${w.replaceAll('"', "")}"`);

/**
 * The queries to run in order: every word (Obsidian's default AND), then any of
 * them. Null when there is nothing to search for.
 */
export function searchQueries(
  words: readonly string[],
): { all: string; any: string | null } | null {
  if (!words.length) return null;
  return {
    all: words.map(term).join(" "),
    any: words.length > 1 ? words.map(term).join(" OR ") : null,
  };
}

/** How many query words start a word of the note's name (file name without ".md"). */
export function titleMatches(words: readonly string[], name: string): number {
  const parts = name
    .toLowerCase()
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean);
  return words.filter((q) => parts.some((p) => p.startsWith(q.toLowerCase()))).length;
}

export const noteName = (path: string) => path.split("/").pop()?.replace(/\.md$/i, "") ?? path;

/**
 * The matching lines that say the most: those with query words the title does
 * not already show first, in note order.
 */
function snippet(words: readonly string[], title: string, matches: CliSearchResult["matches"]) {
  const inTitle = new Set(words.filter((w) => titleMatches([w], title) > 0));
  const score = (text: string) => {
    const t = text.toLowerCase();
    const found = words.filter((w) => t.includes(w));
    return found.filter((w) => !inTitle.has(w)).length * 10 + found.length;
  };
  return matches
    .map((m, i) => ({ i, text: m.text.trim(), score: score(m.text) }))
    .filter((m) => m.text)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, SNIPPET_LINES)
    .sort((a, b) => a.i - b.i)
    .map((m) => m.text)
    .join(" … ")
    .slice(0, SNIPPET_CHARS);
}

export type Ranked = {
  path: string;
  title: string;
  snippet: string;
  matches: number;
  /** The query that found it: 0 for every word, 1 for any word. */
  pass: number;
};

/**
 * Ranks files: names carrying the query words first, then files that matched
 * every word, then more matching lines, then path.
 */
export function rankResults(
  words: readonly string[],
  passes: readonly (readonly CliSearchResult[])[],
): Ranked[] {
  const byPath = new Map<string, Ranked>();
  passes.forEach((results, pass) => {
    for (const r of results) {
      if (byPath.has(r.file)) continue;
      const title = noteName(r.file);
      byPath.set(r.file, {
        path: r.file,
        title,
        snippet: snippet(words, title, r.matches),
        matches: r.matches.length,
        pass,
      });
    }
  });
  return [...byPath.values()].sort(
    (a, b) =>
      titleMatches(words, b.title) - titleMatches(words, a.title) ||
      a.pass - b.pass ||
      Math.min(b.matches, LINE_CAP) - Math.min(a.matches, LINE_CAP) ||
      a.path.localeCompare(b.path),
  );
}

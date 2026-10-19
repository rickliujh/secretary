/**
 * "Find their ticket" (FR-19.7, D61, Phase 26), pure: the bounded JQL for the
 * owner's projects, and the scoring that may pre-select one result.
 *
 * Code picks a found ticket by itself only when one result clearly matches:
 * the best score, two or more label stems shared with its summary, and no
 * other result scoring the same. Otherwise nothing is selected and the user
 * picks (or leaves it at "None of these").
 */
import type { JiraProjectEntry } from "@/db/schema";
import { tokens } from "@/services/retrieval/ranking";
import { stems } from "@/services/work/grouping";

/** Most results the search asks for (D61). */
export const FOUND_LIMIT = 10;
/** The search gives up after this long; the step is then skipped, not failed. */
export const FOUND_TIMEOUT_MS = 8_000;
/** Label stems a summary must share to be picked by code. */
export const PICK_MIN_SHARED = 2;
/** Most label words the text search uses. */
const MAX_WORDS = 6;
/** Most projects one search names. */
export const MAX_PROJECTS = 10;

const PROJECT_KEY = /^[A-Z][A-Z0-9_]+$/;

/** The project keys of an entry list, user-written first, each once. */
export function projectKeys(entries: readonly JiraProjectEntry[] | null | undefined): string[] {
  // An inferred project the user removed is not searched.
  const list = [...(entries ?? [])]
    .filter((e) => !e.off)
    .sort((a, b) => Number(a.by === "sync") - Number(b.by === "sync"));
  return [...new Set(list.map((e) => e.key.trim().toUpperCase()))].filter((k) =>
    PROJECT_KEY.test(k),
  );
}

/**
 * Where to look for the owner's ticket: the person's projects, else their
 * team's (or the owning team's), else none, in which case no search runs.
 */
export function ownerProjects(owner: {
  person: readonly JiraProjectEntry[] | null;
  team: readonly JiraProjectEntry[] | null;
}): string[] {
  const own = projectKeys(owner.person);
  return own.length ? own : projectKeys(owner.team);
}

/**
 * The words of a wait label the search uses: stop words, short words and
 * numbers removed, letters and digits only (so nothing in them can break out
 * of the JQL string or be read as a Lucene operator).
 */
export function searchWords(label: string): string[] {
  return [
    ...new Set(
      tokens(label)
        .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ""))
        .filter((t) => t.length >= 3 && !/^(and|or|not|to)$/.test(t)),
    ),
  ].slice(0, MAX_WORDS);
}

/** A JQL string literal: quotes and backslashes escaped, Lucene operators removed. */
export function jqlText(value: string): string {
  const plain = value
    .replace(/[+\-&|!(){}[\]^~*?:/]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `"${plain.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * `project in (PLAT) AND statusCategory != Done AND text ~ "payments cert"
 * ORDER BY updated DESC`, or null when there is no project to look in or no
 * word to look for.
 */
export function buildWaitSearchJql(opts: {
  projects: readonly string[];
  label: string;
}): string | null {
  const projects = [...new Set(opts.projects)]
    .filter((k) => PROJECT_KEY.test(k))
    .slice(0, MAX_PROJECTS);
  const words = searchWords(opts.label);
  if (projects.length === 0 || words.length === 0) return null;
  return `project in (${projects.join(", ")}) AND statusCategory != Done AND text ~ ${jqlText(
    words.join(" "),
  )} ORDER BY updated DESC`;
}

/** Label stems a summary shares. */
export function sharedStems(label: string, summary: string): number {
  const want = stems(label);
  const have = stems(summary);
  return [...want].filter((s) => have.has(s)).length;
}

export type FoundTicket = {
  key: string;
  summary: string;
  status: string | null;
  url: string | null;
};

/** Results with their score, best first; Jira's order (most recently updated) breaks ties. */
export function scoreFound<T extends FoundTicket>(
  label: string,
  results: readonly T[],
): (T & { score: number })[] {
  return results
    .map((r, i) => ({ r: { ...r, score: sharedStems(label, r.summary) }, i }))
    .sort((a, b) => b.r.score - a.r.score || a.i - b.i)
    .map((x) => x.r);
}

/** The one clear match, or null: nothing when the best score is shared or under two stems. */
export function preselect(scored: readonly { key: string; score: number }[]): string | null {
  const [best, next] = scored;
  if (!best || best.score < PICK_MIN_SHARED) return null;
  if (next && next.score === best.score) return null;
  return best.key;
}

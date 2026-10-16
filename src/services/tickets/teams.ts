/**
 * The Edit dialog's Team options (FR-17.5, D59): the teams seen on synced
 * tickets, and a search in Jira as the user types.
 */
import { isNotNull } from "drizzle-orm";
import { Effect } from "effect";
import { jiraIssues } from "@/db/schema";
import { query } from "@/services/db";

export type TeamOption = { id: string; name: string };

/** Typed text from which Jira is searched. */
export const TEAM_SEARCH_MIN = 2;

/** "Only teams on your synced tickets": the search failed or found nothing. */
export const SYNCED_ONLY = "Only teams on your synced tickets";

/** Each team id once, with the name of its most recently updated ticket, by name. */
export function latestTeams(
  rows: readonly { teamId: string | null; team: string | null; updated: string }[],
): TeamOption[] {
  const latest = new Map<string, { name: string; updated: string }>();
  for (const r of rows) {
    if (!r.teamId || !r.team) continue;
    const seen = latest.get(r.teamId);
    if (!seen || r.updated > seen.updated)
      latest.set(r.teamId, { name: r.team, updated: r.updated });
  }
  return [...latest]
    .map(([id, t]) => ({ id, name: t.name }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** The teams on synced tickets that carry an id. */
export const syncedTeams = Effect.map(
  query((d) =>
    d
      .select({ teamId: jiraIssues.teamId, team: jiraIssues.team, updated: jiraIssues.updated })
      .from(jiraIssues)
      .where(isNotNull(jiraIssues.teamId))
      .all(),
  ),
  latestTeams,
);

/**
 * What the combobox lists besides None: the synced teams whose name holds the
 * typed text (all of them with no text), then, from two characters on, the
 * search results that are not synced teams. `search` is null while no search
 * has answered. The note says when only synced teams can be offered.
 */
export function teamOptions(input: {
  synced: readonly TeamOption[];
  text: string;
  search: readonly TeamOption[] | null;
  searchFailed: boolean;
}): { synced: TeamOption[]; found: TeamOption[]; note: string | null } {
  const text = input.text.trim().toLowerCase();
  const synced = input.synced.filter((t) => !text || t.name.toLowerCase().includes(text));
  if (text.length < TEAM_SEARCH_MIN) return { synced, found: [], note: null };
  const known = new Set(input.synced.map((t) => t.id));
  const found = (input.search ?? []).filter((t) => !known.has(t.id));
  const empty = input.searchFailed || (input.search !== null && input.search.length === 0);
  return { synced, found, note: empty ? SYNCED_ONLY : null };
}

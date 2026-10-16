/** Matching a ticket's Jira team to a team in Context (D59). */

const key = (name: string) => name.trim().toLowerCase();

/** The Context team named like `name`, ignoring case and surrounding spaces; null when none is. */
export function teamNamed<T extends { name: string }>(
  teams: readonly T[],
  name: string | null,
): T | null {
  if (!name?.trim()) return null;
  const wanted = key(name);
  return teams.find((t) => key(t.name) === wanted) ?? null;
}

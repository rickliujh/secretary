/**
 * No duplicate contacts or teams (FR-18.4, D60): the same check for a proposed
 * create in classify validation and again in the Executor at approval.
 */
import { normalizeUsername } from "./schema";

/** A name compared without case and spaces: "Sarah  Lee" and "sarahlee" match. */
export const nameKey = (name: string | null | undefined) =>
  (name ?? "").toLowerCase().replace(/\s+/g, "");

type ContactLike = {
  displayName: string;
  email?: string | null;
  jiraUsername?: string | null;
};

/**
 * The existing contact a new one would duplicate, by display name (case and
 * spaces ignored), email or Jira user; null when none does.
 */
export function existingContact<T extends ContactLike>(
  contacts: readonly T[],
  wanted: ContactLike,
): T | null {
  const name = nameKey(wanted.displayName);
  const email = (wanted.email ?? "").trim().toLowerCase();
  const user = normalizeUsername(wanted.jiraUsername);
  return (
    contacts.find(
      (c) =>
        (!!name && nameKey(c.displayName) === name) ||
        (!!email && (c.email ?? "").trim().toLowerCase() === email) ||
        (!!user && normalizeUsername(c.jiraUsername) === user),
    ) ?? null
  );
}

/** The existing team named like `name` (case and spaces ignored); null when none is. */
export function existingTeam<T extends { name: string }>(
  teams: readonly T[],
  name: string | null | undefined,
): T | null {
  const key = nameKey(name);
  return key ? (teams.find((t) => nameKey(t.name) === key) ?? null) : null;
}

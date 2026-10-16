/**
 * What still uses a contact or team (FR-18.6, D60): revoking an added one
 * deletes it only when nothing points at it, so nothing is left dangling or
 * silently unlinked. The reads are `personUses` and `teamUses` in `queries.ts`.
 */

/** Rows that point at a contact or team; ids where a revoke of the thread may remove them. */
export type DirectoryUses = {
  /** Waits it owns. */
  waits: string[];
  /** Drafts and messages to it. */
  drafts: string[];
  /** Memories about it. */
  memories: string[];
  /** Contacts in the team (teams only). */
  members: string[];
  /** Context notes about it. */
  notes: number;
  /** Inbox items it sent (contacts only). */
  sent: number;
  /** Tickets it asked for (contacts only, FR-10.4). */
  asks: number;
};

export const noUses = (): DirectoryUses => ({
  waits: [],
  drafts: [],
  memories: [],
  members: [],
  notes: 0,
  sent: 0,
  asks: 0,
});

const count = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

/** ["a wait", "2 drafts"]; empty when nothing uses it. */
export function describeUses(u: DirectoryUses): string[] {
  return [
    u.waits.length && count(u.waits.length, "a wait", "waits"),
    u.drafts.length && count(u.drafts.length, "a draft", "drafts"),
    u.memories.length && count(u.memories.length, "a memory", "memories"),
    u.members.length && count(u.members.length, "a contact in the team", "contacts in the team"),
    u.notes && count(u.notes, "a context note", "context notes"),
    u.sent && count(u.sent, "an inbox item they sent", "inbox items they sent"),
    u.asks && count(u.asks, "a small ask they asked for", "small asks they asked for"),
  ].filter((x): x is string => !!x);
}

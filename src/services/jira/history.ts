/** Issue changelog mapping and the `since` cut-off, shared by Cloud and Data Center. */
import { jiraDateToIso } from "./dates";
import type { IssueChange } from "./index";
import type { ChangelogHistory } from "./schemas";

export function toIssueChange(h: ChangelogHistory): IssueChange {
  return {
    at: jiraDateToIso(h.created),
    // Same rule as `UserRef.id`: accountId on Cloud, name (username) on Data Center.
    author: h.author?.accountId || h.author?.name || null,
    authorDisplay: h.author?.displayName || null,
    items: h.items.map((i) => ({
      field: i.field,
      from: i.fromString ?? null,
      to: i.toString ?? null,
      fromId: i.from,
      toId: i.to,
    })),
  };
}

const time = (iso: string) => new Date(iso).getTime();

/** Entries at or after `since`, oldest first, each entry once (pages may overlap). */
export function changesSince(histories: readonly ChangelogHistory[], since: string): IssueChange[] {
  const cutoff = time(since);
  const seen = new Set<string>();
  const out: IssueChange[] = [];
  for (const h of histories) {
    if (h.id !== null) {
      if (seen.has(h.id)) continue;
      seen.add(h.id);
    }
    const change = toIssueChange(h);
    if (time(change.at) >= cutoff) out.push(change);
  }
  return out.sort((a, b) => time(a.at) - time(b.at));
}

/** True when a page (oldest first) starts before `since`, so older pages are not needed. */
export const reachesBefore = (page: readonly ChangelogHistory[], since: string) => {
  const first = page[0];
  return first !== undefined && time(jiraDateToIso(first.created)) < time(since);
};

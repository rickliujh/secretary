/** Pure JQL construction for sync (design.md section 5). */
import { toJqlDate } from "@/services/jira/dates";
import { jqlFieldRef } from "@/services/jira/fields";
import { ISSUE_KEY_RE } from "@/services/proposals/schema";

/** Kept under this name for the settings form. */
export const ISSUE_KEY = ISSUE_KEY_RE;

/** Removes a trailing ORDER BY so the clause can be combined with others. */
export function stripOrderBy(jql: string): string {
  return jql.replace(/\s+order\s+by\s+[\s\S]*$/i, "").trim();
}

export function buildScopeJql(opts: {
  userJql: string;
  trackedEpics: readonly string[];
  epicLinkFieldId?: string;
}): string {
  const parts: string[] = [];
  const user = stripOrderBy(opts.userJql);
  if (user) parts.push(`(${user})`);
  const epics = opts.trackedEpics.filter((k) => ISSUE_KEY_RE.test(k));
  if (epics.length > 0) {
    const list = epics.join(", ");
    parts.push(`key in (${list})`);
    if (opts.epicLinkFieldId) parts.push(`${jqlFieldRef(opts.epicLinkFieldId)} in (${list})`);
    parts.push(`parent in (${list})`);
  }
  if (parts.length === 0) throw new Error("Sync scope is empty: set a JQL query or tracked epics.");
  return parts.join(" OR ");
}

/** Overlap applied to the watermark so clock skew and same-minute updates are not missed. */
const WATERMARK_OVERLAP_MS = 5 * 60 * 1000;

export function withUpdatedSince(
  scope: string,
  watermarkIso: string | undefined,
  timeZone?: string,
): string {
  const base = `(${scope})`;
  if (!watermarkIso) return `${base} ORDER BY updated ASC`;
  const since = new Date(new Date(watermarkIso).getTime() - WATERMARK_OVERLAP_MS).toISOString();
  return `${base} AND updated >= "${toJqlDate(since, timeZone)}" ORDER BY updated ASC`;
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Dependency proposals as compact rows (D46): one line and one approve button,
 * the details behind an expand. A change to an open wait, and a new wait on an
 * existing ticket; a wait on a new ticket joins its small ask's Track row.
 */
import { describeWaitUpdate, NEW_REF_RE, type ProposalPayload } from "./schema";

export const isCompact = (p: ProposalPayload) =>
  p.kind === "update_dependency" || (p.kind === "link_dependency" && !NEW_REF_RE.test(p.target));

/** Names of contacts and teams by id, for the line. */
export type Names = { person: (id: string) => string | null; team: (id: string) => string | null };

/** The one line a compact row shows; null for kinds that are not compact. */
export function compactLine(p: ProposalPayload, names: Names): string | null {
  switch (p.kind) {
    case "update_dependency":
      return `${describeWaitUpdate(p)}${p.summary ? ` — “${p.summary}”` : ""}`;
    case "link_dependency": {
      if (!isCompact(p)) return null;
      const owner =
        (p.ownerPersonId && names.person(p.ownerPersonId)) ||
        (p.ownerTeamId && names.team(p.ownerTeamId)) ||
        null;
      return `${p.target} waits on ${p.label}${owner && owner !== p.label ? ` (${owner})` : ""}${
        p.expectedAt ? `, expected ${p.expectedAt}` : ""
      }`;
    }
    default:
      return null;
  }
}

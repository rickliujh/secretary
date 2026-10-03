/**
 * Track bundles (D44, FR-10.3): a small-ask create and the proposals of the same
 * item that hang on its `$new` ref (a dependency, a comment, a draft) show as
 * one row and are approved together, the create first.
 */
import { effectivePayload, issueRefs, type ProposalPayload } from "@/services/proposals/schema";

export type BundleProposal = {
  id: string;
  intakeItemId: string | null;
  kind: string;
  status: string;
  seq: number;
  payload: unknown;
  editedPayload: unknown;
};

export type ThreadEntry<P> =
  | { type: "card"; proposal: P }
  | { type: "track"; create: P; members: P[] };

const shown = (p: BundleProposal) => p.status !== "superseded";

/**
 * Groups one turn's proposals in order: each small-ask create becomes a track
 * entry where it stands, taking the later proposals that point at it; the rest
 * stay cards. A proposal pointing at two creates joins the first.
 */
export function groupSmallAsks<P extends BundleProposal>(list: readonly P[]): ThreadEntry<P>[] {
  const payloads = new Map<string, ProposalPayload>(list.map((p) => [p.id, effectivePayload(p)]));
  const taken = new Set<string>();
  const bundles = new Map<string, P[]>();
  for (const create of list) {
    const c = payloads.get(create.id);
    if (!shown(create) || c?.kind !== "create_issue" || !c.smallAsk || !create.intakeItemId)
      continue;
    const members = list.filter((p) => {
      if (p.id === create.id || taken.has(p.id) || !shown(p) || p.kind === "create_issue")
        return false;
      if (p.kind === "needs_clarification" || p.intakeItemId !== create.intakeItemId) return false;
      const payload = payloads.get(p.id);
      return !!payload && issueRefs(payload, { only: "new" }).includes(c.ref);
    });
    for (const m of members) taken.add(m.id);
    bundles.set(create.id, members);
  }
  return list.flatMap((p): ThreadEntry<P>[] => {
    if (!shown(p)) return [];
    const members = bundles.get(p.id);
    if (members) return [{ type: "track", create: p, members }];
    return taken.has(p.id) ? [] : [{ type: "card", proposal: p }];
  });
}

/** The ids Track approves, in execution order: the create, then its members by seq. */
export function trackOrder<P extends BundleProposal>(create: P, members: readonly P[]): string[] {
  return [create, ...[...members].sort((a, b) => a.seq - b.seq)]
    .filter((p) => p.status === "pending" || p.status === "failed")
    .map((p) => p.id);
}

/**
 * Track bundles (D44, FR-10.3): a small-ask create and the proposals of the same
 * item that hang on its `$new` ref show as one row and are approved together,
 * the create first. Only the kinds in `BUNDLE_KINDS` join, so every write Track
 * runs is one the row shows; anything else stays a card below it.
 */
import {
  effectivePayload,
  issueRefs,
  type ProposalKind,
  type ProposalPayload,
} from "@/services/proposals/schema";

/**
 * Kinds that may join a Track row, each summarised in one line on the row face
 * (`bundleLine`). Adding a kind means adding its line there.
 */
export const BUNDLE_KINDS = ["link_dependency", "link_issues"] as const satisfies ProposalKind[];
export type BundleKind = (typeof BUNDLE_KINDS)[number];

const isBundleKind = (kind: string): kind is BundleKind =>
  (BUNDLE_KINDS as readonly string[]).includes(kind);

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

/** The `$new` refs of creates that already ran, so members may point at them too. */
export function executedRefs(list: readonly BundleProposal[]): Set<string> {
  const refs = new Set<string>();
  for (const p of list) {
    if (p.status !== "executed" || p.kind !== "create_issue") continue;
    const payload = effectivePayload(p);
    if (payload.kind === "create_issue") refs.add(payload.ref);
  }
  return refs;
}

/**
 * Groups one turn's proposals in order: each small-ask create becomes a track
 * entry where it stands, taking the later proposals of the same item that point
 * at it, are of a bundle kind, and point at no other `$new` ref that is not yet
 * created. The rest stay cards. A proposal pointing at two creates joins the
 * first. `done` adds refs created earlier in the thread (from other turns).
 */
export function groupSmallAsks<P extends BundleProposal>(
  list: readonly P[],
  done: ReadonlySet<string> = new Set(),
): ThreadEntry<P>[] {
  const payloads = new Map<string, ProposalPayload>(list.map((p) => [p.id, effectivePayload(p)]));
  const created = new Set([...done, ...executedRefs(list)]);
  const taken = new Set<string>();
  const bundles = new Map<string, P[]>();
  for (const create of list) {
    const c = payloads.get(create.id);
    if (!shown(create) || c?.kind !== "create_issue" || !c.smallAsk || !create.intakeItemId)
      continue;
    const members = list.filter((p) => {
      if (p.id === create.id || taken.has(p.id) || !shown(p) || !isBundleKind(p.kind)) return false;
      if (p.intakeItemId !== create.intakeItemId) return false;
      const payload = payloads.get(p.id);
      if (!payload || payload.kind !== p.kind) return false;
      const refs = issueRefs(payload, { only: "new" });
      return refs.includes(c.ref) && refs.every((r) => r === c.ref || created.has(r));
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

/**
 * One line per member for the row face, so every write Track runs is visible.
 * `self` is the create's ref: a blocker link reads from the new ticket's side.
 */
export function bundleLine(p: ProposalPayload, self?: string): string | null {
  switch (p.kind) {
    case "link_dependency":
      return `Waits on ${p.label}`;
    case "link_issues":
      if (p.target === self) return `Blocked by ${p.blocker}`;
      if (p.blocker === self) return `Blocks ${p.target}`;
      return `${p.target} blocked by ${p.blocker}`;
    default:
      return null;
  }
}

/** The ids Track approves, in execution order: the create, then its members by seq. */
export function trackOrder<P extends BundleProposal>(create: P, members: readonly P[]): string[] {
  return [create, ...[...members].sort((a, b) => a.seq - b.seq)]
    .filter((p) => p.status === "pending" || p.status === "failed")
    .map((p) => p.id);
}

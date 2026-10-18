/**
 * Merges per-item proposals into one ordered list (design.md 7.3 step 5):
 * `$new:n`, `$person:n` and `$team:n` refs are renumbered into one namespace
 * each, a create repeated across items collapses to the first, and exact
 * duplicates are dropped.
 */
import type { MappedProposal } from "@/prompts/classify";
import { ownRef, type ProposalPayload, resolveRefs } from "@/services/proposals/schema";

export type MergedProposal = MappedProposal & { itemIndex: number };

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Stable identity for duplicate detection, ignoring free-text rationale. */
function identity(p: ProposalPayload): string {
  if (p.kind === "create_issue") return `create:${p.projectKey}:${norm(p.summary)}`;
  // One new contact or team per name across items (D60).
  if (p.kind === "create_person") return `person:${norm(p.displayName)}`;
  if (p.kind === "create_team") return `team:${norm(p.name)}`;
  if (p.kind === "add_comment") return `comment:${p.target}:${norm(p.bodyMd)}`;
  if (p.kind === "link_dependency") return `dep:${p.target}:${p.externalRef ?? norm(p.label)}`;
  if (p.kind === "link_issues") return `blocks:${p.blocker}:${p.target}`;
  // One change of each kind per wait; two items both resolving it are one proposal.
  if (p.kind === "update_dependency") return `wait:${p.dependencyId}:${p.action}`;
  if (p.kind === "transition_issue") return `transition:${p.target}`;
  if (p.kind === "move_to_sprint") return `sprint:${p.target}:${p.sprintId}`;
  if (p.kind === "remember") return `remember:${norm(p.content)}`;
  return JSON.stringify(p);
}

/**
 * `reserved` holds refs already used in the thread (decided creates, and pending
 * proposals of items not being revised); new refs are numbered around them.
 */
export function mergeItemProposals(
  items: readonly MappedProposal[][],
  reserved: ReadonlySet<string> = new Set(),
): MergedProposal[] {
  const out: MergedProposal[] = [];
  const seen = new Map<string, MergedProposal>();
  const next = new Map<string, number>();
  // A ref's namespace: "$new", "$person" or "$team".
  const space = (ref: string) => ref.slice(0, ref.indexOf(":"));
  const nextRef = (ns: string) => {
    let n = next.get(ns) ?? 1;
    while (reserved.has(`${ns}:${n}`)) n++;
    next.set(ns, n + 1);
    return `${ns}:${n}`;
  };
  items.forEach((proposals, itemIndex) => {
    // Local ref -> global ref (or the ref of an equivalent earlier create).
    const local = new Map<string, string>();
    for (const m of proposals) {
      const own = ownRef(m.payload);
      if (!own) continue;
      const dup = seen.get(identity(m.payload));
      local.set(own, (dup && ownRef(dup.payload)) || nextRef(space(own)));
    }
    for (const m of proposals) {
      const own = ownRef(m.payload);
      let payload = resolveRefs(m.payload, local);
      if (own && "ref" in payload) payload = { ...payload, ref: local.get(own) ?? own };
      const key = identity(payload);
      const existing = seen.get(key);
      if (existing) {
        // Keep the more confident rationale but only one action.
        if (m.confidence > existing.confidence)
          Object.assign(existing, {
            rationale: m.rationale,
            evidence: m.evidence,
            confidence: m.confidence,
          });
        continue;
      }
      const merged = { ...m, payload, itemIndex };
      seen.set(key, merged);
      out.push(merged);
    }
  });
  // Creates first, teams, then contacts (who may be in them), then issues, each in
  // ref order, so later proposals can use what they make.
  const GROUP: Partial<Record<ProposalPayload["kind"], number>> = {
    create_team: 0,
    create_person: 1,
    create_issue: 2,
  };
  const order = (p: ProposalPayload) => {
    const own = ownRef(p);
    return own
      ? (GROUP[p.kind] ?? 3) * 1_000_000 + Number(own.split(":")[1])
      : Number.POSITIVE_INFINITY;
  };
  return out
    .map((m, i) => ({ m, i }))
    .sort((a, b) => order(a.m.payload) - order(b.m.payload) || a.i - b.i)
    .map(({ m }) => m);
}

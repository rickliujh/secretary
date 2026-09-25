/**
 * Merges per-item proposals into one ordered list (design.md 7.3 step 5):
 * `$new:n` refs are renumbered into one namespace, a create_issue repeated
 * across items collapses to the first, and exact duplicates are dropped.
 */
import type { MappedProposal } from "@/prompts/classify";
import { NEW_REF_RE, type ProposalPayload, resolveRefs } from "@/services/proposals/schema";

export type MergedProposal = MappedProposal & { itemIndex: number };

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Stable identity for duplicate detection, ignoring free-text rationale. */
function identity(p: ProposalPayload): string {
  if (p.kind === "create_issue") return `create:${p.projectKey}:${norm(p.summary)}`;
  if (p.kind === "add_comment") return `comment:${p.target}:${norm(p.bodyMd)}`;
  if (p.kind === "link_dependency") return `dep:${p.target}:${p.externalRef ?? norm(p.label)}`;
  if (p.kind === "transition_issue") return `transition:${p.target}`;
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
  let n = 1;
  const nextRef = () => {
    while (reserved.has(`$new:${n}`)) n++;
    return `$new:${n++}`;
  };
  items.forEach((proposals, itemIndex) => {
    // Local $new:n -> global ref (or the ref of an equivalent earlier create).
    const local = new Map<string, string>();
    for (const m of proposals) {
      if (m.payload.kind !== "create_issue") continue;
      const dup = seen.get(identity(m.payload));
      local.set(
        m.payload.ref,
        dup && dup.payload.kind === "create_issue" ? dup.payload.ref : nextRef(),
      );
    }
    for (const m of proposals) {
      const ownRef = m.payload.kind === "create_issue" ? m.payload.ref : null;
      let payload = resolveRefs(m.payload, local);
      if (payload.kind === "create_issue" && ownRef)
        payload = { ...payload, ref: local.get(ownRef) ?? payload.ref };
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
  // Creates first, in ref order, so later proposals can use their keys.
  const refNum = (p: ProposalPayload) =>
    p.kind === "create_issue" ? Number(p.ref.split(":")[1]) : Number.POSITIVE_INFINITY;
  return out
    .map((m, i) => ({ m, i }))
    .sort((a, b) => refNum(a.m.payload) - refNum(b.m.payload) || a.i - b.i)
    .map(({ m }) => m);
}

export const isNewRef = (v: string) => NEW_REF_RE.test(v);

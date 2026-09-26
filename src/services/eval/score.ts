/**
 * Scoring for the intake eval set and for evaluation replay (FR-9.4).
 * Compares proposal kinds and targets, not wording.
 */
import type { ProposalKind, ProposalPayload } from "@/services/proposals/schema";

export type Expected = {
  kind: ProposalKind;
  target?: string;
  /** The date the proposal must set: dueDate, or expectedAt for a dependency. */
  date?: string;
  /** Fields the payload must have, e.g. { issueType: "Bug", assignee: "ana.b" }. */
  fields?: Record<string, unknown>;
};

const hasFields = (p: ProposalPayload, fields: Record<string, unknown>) => {
  const flat = { ...p, ...("changes" in p ? p.changes : {}) } as Record<string, unknown>;
  return Object.entries(fields).every(([k, v]) => flat[k] === v);
};

const dateOf = (p: ProposalPayload): string | null | undefined => {
  if (p.kind === "create_issue") return p.dueDate;
  if (p.kind === "update_issue") return p.changes.dueDate;
  if (p.kind === "link_dependency") return p.expectedAt;
  return undefined;
};

export type EvalExpectation = {
  /** Every one of these must be proposed. */
  required: Expected[];
  /** None of these kinds may be proposed. */
  forbiddenKinds?: ProposalKind[];
};

/** The issue a payload acts on, or its main subject, for matching. */
function payloadTarget(p: ProposalPayload): string | undefined {
  switch (p.kind) {
    case "update_issue":
    case "add_comment":
    case "transition_issue":
    case "link_dependency":
      return p.target;
    case "create_issue":
      return p.epic ?? p.projectKey;
    case "update_person":
      return p.personId;
    case "update_team":
      return p.teamId;
    default:
      return undefined;
  }
}

export type CaseScore = { pass: boolean; missing: Expected[]; forbidden: ProposalKind[] };

export function scoreCase(
  expected: EvalExpectation,
  actual: readonly ProposalPayload[],
): CaseScore {
  const missing = expected.required.filter(
    (e) =>
      !actual.some(
        (a) =>
          a.kind === e.kind &&
          (e.target === undefined || payloadTarget(a) === e.target) &&
          (e.date === undefined || dateOf(a) === e.date) &&
          (e.fields === undefined || hasFields(a, e.fields)),
      ),
  );
  const forbidden = [
    ...new Set(actual.map((a) => a.kind).filter((k) => expected.forbiddenKinds?.includes(k))),
  ];
  return { pass: missing.length === 0 && forbidden.length === 0, missing, forbidden };
}

/** Kind:target signature of a set of proposals, ignoring questions and order. */
export function signature(actual: readonly ProposalPayload[]): string {
  return actual
    .filter((p) => p.kind !== "needs_clarification")
    .map((p) => `${p.kind}:${payloadTarget(p) ?? ""}`)
    .sort()
    .join(" ");
}

/** One replayed item: what the user approved or rejected, and what the model proposed now. */
export type ReplayItem = {
  done: readonly ProposalPayload[];
  rejected: readonly ProposalPayload[];
  got: readonly ProposalPayload[];
};

export type KindAgreement = {
  kind: ProposalKind;
  /** Proposals of this kind the user approved. */
  approved: number;
  /** Of those, how many the replayed model proposed again (same kind and target). */
  matched: number;
  /** Replayed proposals of this kind the user had rejected before. */
  repeatedRejections: number;
};

const sameAction = (a: ProposalPayload, b: ProposalPayload) =>
  a.kind === b.kind && payloadTarget(a) === payloadTarget(b);

/** Agreement per proposal kind for evaluation replay (FR-9.4). */
export function replayAgreement(items: readonly ReplayItem[]): KindAgreement[] {
  const by = new Map<ProposalKind, KindAgreement>();
  const row = (kind: ProposalKind) => {
    const r = by.get(kind) ?? { kind, approved: 0, matched: 0, repeatedRejections: 0 };
    by.set(kind, r);
    return r;
  };
  for (const item of items) {
    for (const d of item.done) {
      const r = row(d.kind);
      r.approved++;
      if (item.got.some((g) => sameAction(g, d))) r.matched++;
    }
    for (const g of item.got)
      if (item.rejected.some((x) => sameAction(g, x)) && !item.done.some((d) => sameAction(g, d)))
        row(g.kind).repeatedRejections++;
  }
  return [...by.values()].sort((a, b) => b.approved - a.approved || a.kind.localeCompare(b.kind));
}

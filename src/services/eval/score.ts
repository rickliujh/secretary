/**
 * Scoring for the intake eval set and, later, evaluation replay (FR-9.4).
 * Compares proposal kinds and targets, not wording.
 */
import type { ProposalKind, ProposalPayload } from "@/services/proposals/schema";

export type Expected = {
  kind: ProposalKind;
  target?: string;
  /** The date the proposal must set: dueDate, or expectedAt for a dependency. */
  date?: string;
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
export function payloadTarget(p: ProposalPayload): string | undefined {
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
          (e.date === undefined || dateOf(a) === e.date),
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

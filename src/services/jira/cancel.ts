/**
 * Statuses that end a ticket without doing it (D43): moving there needs a
 * comment saying why. One definition for the classify validation
 * (`prompts/classify.ts`) and Today's Done and Drop (`dashboard/closing.ts`).
 */
export const CANCEL_STATUS =
  /cancel|won'?t\s*(do|fix)|wontfix|abandon|reject|declin|obsolete|duplicate|invalid|not\s*needed|descoped/i;

/** Whether a status (or transition) name is cancel-like. */
export const isCancelStatus = (status: string) => CANCEL_STATUS.test(status);

/**
 * Status names a revoked ticket may end in (D54), in the user's order of
 * preference: cancelled (or canceled), won't do, rejected, declined.
 */
const REVOKE_STATUS = [/\bcancel+ed\b|^cancel$/i, /won'?t\s*do/i, /reject/i, /declin/i] as const;

type TransitionLike = {
  id: string;
  name: string;
  to: { name: string; statusCategory?: { key: string } };
};

/**
 * The status a revoked ticket the user may not delete ends in (D54): the first
 * named like cancelled, won't do, rejected or declined (in that order), else the
 * first in the done category, else null.
 */
export function revokeStatus<T extends { name: string; category?: string }>(
  statuses: readonly T[],
): T | null {
  for (const re of REVOKE_STATUS) {
    const s = statuses.find((x) => re.test(x.name));
    if (s) return s;
  }
  return statuses.find((x) => x.category === "done") ?? null;
}

/** The transition into `revokeStatus` of the targets available now (D54). */
export function revokeTransition<T extends TransitionLike>(available: readonly T[]): T | null {
  const target = revokeStatus(
    available.map((t) => ({ name: t.to.name, category: t.to.statusCategory?.key, t })),
  );
  return target?.t ?? null;
}

/** Whether a status name is one `revokeTransition` would pick by name. */
export const isRevokeStatus = (name: string) => REVOKE_STATUS.some((re) => re.test(name));

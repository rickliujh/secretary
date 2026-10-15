/**
 * Statuses that end a ticket without doing it (D43): moving there needs a
 * comment saying why. One definition for the classify validation
 * (`prompts/classify.ts`) and Today's Done and Drop (`dashboard/closing.ts`).
 */
export const CANCEL_STATUS =
  /cancel|won'?t\s*(do|fix)|wontfix|abandon|reject|declin|obsolete|duplicate|invalid|not\s*needed|descoped/i;

/** Whether a status (or transition) name is cancel-like. */
export const isCancelStatus = (status: string) => CANCEL_STATUS.test(status);

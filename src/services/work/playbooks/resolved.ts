/**
 * The "wait resolved" playbook (FR-19.7, D61, Phase 26), pure: resolving a
 * wait (an `update_dependency` resolve proposed by classify or the chat, for
 * instance from the owner's "it's done") brings its chores along:
 *
 * 1. the resolve itself, the step the others hang on;
 * 2. a comment on the ticket that it no longer waits (`commentWaits`);
 * 3. the move back out of the Blocked-like status, when a playbook moved the
 *    ticket there (the wait's `data.blocked`), it is still there and no other
 *    wait on it is open (one of those then remembers the status, `Proposals`).
 *
 * Approving it also wakes the ticket (Today's woken row) when nothing else
 * holds it: no other open wait and no open blocker (`Proposals`).
 */
import type {
  PayloadOf,
  ProposalPayload,
  StoredProposalPayload,
} from "@/services/proposals/schema";
import type { Instructions } from "@/services/settings/schema";
import type { StepDraft } from "../schema";

export type ResolvedInput = {
  /** The resolve as proposed; kept as the first step. */
  resolve: PayloadOf<"update_dependency">;
  wait: {
    id: string;
    issueKey: string;
    label: string;
    ownerName: string;
    blocked: { issueKey: string; from: string; to: string } | null;
  };
  /** The ticket's status now; null when not cached. */
  targetStatus: string | null;
  /** Other waits still open on the ticket: while there are any, it stays Blocked. */
  otherOpenWaits: number;
  instructions: Instructions;
};

export type ResolvedPlaybook = { title: string; why: string; steps: StepDraft[] };

const step = (payload: StoredProposalPayload, label: string, required = false): StepDraft => ({
  payload: payload as ProposalPayload,
  label,
  required,
  choice: false,
});

/** "No longer waiting on Sarah for the cert: it is done." */
export const resolvedComment = (owner: string, label: string) =>
  `No longer waiting on ${owner} for ${label}: it is done.`;

export function resolvedPlaybook(input: ResolvedInput): ResolvedPlaybook {
  const { wait } = input;
  const steps: StepDraft[] = [
    step(input.resolve, `Resolve the wait on ${wait.ownerName} for "${wait.label}"`, true),
  ];
  if (input.instructions.commentWaits) {
    const body = resolvedComment(wait.ownerName, wait.label);
    steps.push(
      step(
        { kind: "add_comment", target: wait.issueKey, bodyMd: body },
        `Comment on ${wait.issueKey}: "${body}"`,
      ),
    );
  }
  const b = wait.blocked;
  if (
    b &&
    b.issueKey === wait.issueKey &&
    input.otherOpenWaits === 0 &&
    input.targetStatus &&
    input.targetStatus.toLowerCase() === b.to.toLowerCase()
  )
    steps.push(
      step(
        { kind: "transition_issue", target: wait.issueKey, toStatus: b.from },
        `Move ${wait.issueKey} from ${b.to} back to ${b.from}`,
      ),
    );
  return {
    title: `${wait.ownerName} delivered: ${wait.label}`,
    why: `The wait on ${wait.ownerName} for "${wait.label}" on ${wait.issueKey} is over.`,
    steps,
  };
}

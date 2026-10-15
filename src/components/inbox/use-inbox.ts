import {
  type Mutation,
  useIsMutating,
  useMutation,
  useMutationState,
  useQueryClient,
} from "@tanstack/react-query";
import { Effect } from "effect";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { isInterrupted } from "@/app/errors";
import { useAppMutation, useErrorToast } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { type AppServices, run } from "@/app/runtime";
import { Intake, type ReplyInput, type TriageInput, type TriageResult } from "@/services/intake";
import { type ProposalPayload, Proposals } from "@/services/proposals";

/**
 * Everything a decision can change: the thread, tickets, contacts, and what
 * approved proposals create (dependencies, drafts, memories). Edits and
 * rejections are also kept as corrections on the Memory page.
 */
const DECISION_KEYS = [
  queryKeys.inbox,
  queryKeys.tickets,
  queryKeys.directory,
  queryKeys.dependencies,
  queryKeys.drafts,
  queryKeys.memories,
];

export function useInvalidateAfterDecision() {
  const client = useQueryClient();
  return () => {
    for (const key of DECISION_KEYS) void client.invalidateQueries({ queryKey: key });
  };
}

const summarise = (r: TriageResult) =>
  r.proposals || r.questions
    ? `${r.proposals} proposal${r.proposals === 1 ? "" : "s"}${r.questions ? ` and ${r.questions} question${r.questions === 1 ? "" : "s"}` : ""} to review`
    : "Nothing to do in that input";

/** Names saves of a pending proposal's edits (D44 rows, D57 sprint switch). */
export const SAVE_EDIT_MUTATION = ["save-edit"] as const;
/** Names intake turns that revise a thread: replies and re-triage. */
export const INTAKE_TURN_MUTATION = ["intake-turn"] as const;

export type SaveEditInput = { id: string; edited: ProposalPayload; inboxItemId?: string | null };

const saveOf = (m: Pick<Mutation, "state">) => (m.state.variables ?? null) as SaveEditInput | null;

/** A save of this proposal's edit (or of any in this thread) is running. */
export function useSavingEdit(filter: { id?: string; inboxItemId?: string | null }) {
  return (
    useIsMutating({
      mutationKey: SAVE_EDIT_MUTATION,
      predicate: (m) => {
        const v = saveOf(m);
        if (!v) return false;
        if (filter.id) return v.id === filter.id;
        return !!filter.inboxItemId && v.inboxItemId === filter.inboxItemId;
      },
    }) > 0
  );
}

/** The newest edit of this proposal still being saved, from any component; null when none. */
export function usePendingEdit(id: string): ProposalPayload | null {
  const pending = useMutationState({
    filters: {
      mutationKey: SAVE_EDIT_MUTATION,
      status: "pending",
      predicate: (m) => saveOf(m)?.id === id,
    },
    select: (m) => saveOf(m)?.edited ?? null,
  });
  return pending.at(-1) ?? null;
}

/** An intake turn (a reply or a re-triage) is revising this thread. */
export function useTurnRunning(inboxItemId: string | null) {
  return (
    useIsMutating({
      mutationKey: INTAKE_TURN_MUTATION,
      predicate: (m) => {
        const v = m.state.variables as { inboxItemId?: string } | string | undefined;
        return (
          !!inboxItemId &&
          (v === inboxItemId || (typeof v === "object" && v?.inboxItemId === inboxItemId))
        );
      },
    }) > 0
  );
}

/** Runs one intake turn with progress messages and a cancel button. */
function useIntakeTurn<I>(
  f: (
    intake: Intake["Type"],
    input: I,
    onProgress: (m: string) => void,
  ) => Effect.Effect<TriageResult, unknown>,
  onDone?: (inboxItemId: string) => void,
  mutationKey?: readonly unknown[],
) {
  const onError = useErrorToast();
  const invalidate = useInvalidateAfterDecision();
  const [progress, setProgress] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const mutation = useMutation({
    ...(mutationKey ? { mutationKey } : {}),
    mutationFn: (input: I) => {
      controller.current = new AbortController();
      return run(
        Effect.flatMap(Intake, (i) => f(i, input, setProgress)),
        controller.current.signal,
      );
    },
    onSuccess: (r) => {
      toast.success(summarise(r));
      onDone?.(r.inboxItemId);
    },
    onError: (e) => {
      // A cancel is the user's choice, not an error.
      if (!isInterrupted(e)) onError(e);
    },
    onSettled: () => {
      setProgress(null);
      invalidate();
    },
  });
  return { ...mutation, progress, cancel: () => controller.current?.abort() };
}

/** Starts a thread (D22). */
export function useTriage(onDone?: (inboxItemId: string) => void) {
  return useIntakeTurn(
    (i, input: Omit<TriageInput, "onProgress">, onProgress) => i.triage({ ...input, onProgress }),
    onDone,
  );
}

/** Replies in a thread: new input, an instruction or an answer (D22). */
export function useReply() {
  return useIntakeTurn(
    (i, input: Omit<ReplyInput, "onProgress">, onProgress) => i.reply({ ...input, onProgress }),
    undefined,
    INTAKE_TURN_MUTATION,
  );
}

/** A decision can partly apply before it fails, so views refresh either way. */
function useDecisionMutation<A, E, I>(
  program: (input: I) => Effect.Effect<A, E, AppServices>,
  mutationKey?: readonly unknown[],
  opts: { awaitRefresh?: boolean } = {},
) {
  return useAppMutation(program, {
    invalidate: DECISION_KEYS,
    invalidateOnError: true,
    ...(mutationKey ? { mutationKey } : {}),
    ...opts,
  });
}

/** Names revoke mutations, so every Revoke of a thread can wait while one runs. */
export const REVOKE_MUTATION = ["revoke"] as const;
/** What a running revoke carries: the proposal and its thread. */
export type RevokeInput = {
  id: string;
  inboxItemId: string | null;
  confirmed: readonly string[];
};

const withProposals =
  <A, E, I>(f: (p: Proposals["Type"], input: I) => Effect.Effect<A, E>) =>
  (input: I) =>
    Effect.flatMap(Proposals, (p) => f(p, input));

export function useDecisions() {
  const approve = useDecisionMutation(
    withProposals((p, i: { id: string; edited?: ProposalPayload }) => p.approve(i.id, i.edited)),
  );
  const reject = useDecisionMutation(withProposals((p, id: string) => p.reject(id)));
  const approveAll = useDecisionMutation(
    withProposals((p, inboxItemId: string) => p.approveAll(inboxItemId)),
  );
  const dismiss = useDecisionMutation(
    withProposals((p, inboxItemId: string) => p.dismiss(inboxItemId)),
  );
  /** Track (D44): the small-ask create and what hangs on it, in order. */
  const track = useDecisionMutation(
    withProposals(
      (p, i: { ids: readonly string[]; edits?: Readonly<Record<string, ProposalPayload>> }) =>
        p.track(i.ids, i.edits),
    ),
  );
  /**
   * Keeps a row change or the sprint switch on a pending proposal, so any
   * approve uses it (D44, D57). Named, and pending until the thread is read
   * again, so approvals can wait for it.
   */
  const saveEdit = useDecisionMutation(
    withProposals((p, i: SaveEditInput) => p.saveEdit(i.id, i.edited)),
    SAVE_EDIT_MUTATION,
    { awaitRefresh: true },
  );
  /** Revoke (FR-14): the steps the user confirmed; a failed step comes back as a result. */
  const revoke = useDecisionMutation(
    withProposals((p, i: RevokeInput) => p.revoke(i.id, i.confirmed)),
    REVOKE_MUTATION,
  );
  const retriage = useDecisionMutation(
    (inboxItemId: string) => Effect.flatMap(Intake, (i) => i.retriage(inboxItemId)),
    INTAKE_TURN_MUTATION,
  );
  return { approve, reject, approveAll, track, saveEdit, dismiss, retriage, revoke };
}

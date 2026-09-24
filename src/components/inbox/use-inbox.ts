import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useErrorToast } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { listPeople, listTeams } from "@/services/directory/queries";
import { Intake, type TriageInput } from "@/services/intake";
import { type ProposalPayload, Proposals } from "@/services/proposals";
import { listTicketRows } from "@/services/tickets/queries";

/** Everything a decision can change: inbox, tickets, directory, memories. */
function useInvalidateAfterDecision() {
  const client = useQueryClient();
  return () => {
    for (const key of [queryKeys.inbox, queryKeys.tickets, queryKeys.directory])
      void client.invalidateQueries({ queryKey: key });
  };
}

export function useTriage(onDone?: (inboxItemId: string) => void) {
  const onError = useErrorToast();
  const invalidate = useInvalidateAfterDecision();
  const [progress, setProgress] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const mutation = useMutation({
    mutationFn: (input: Omit<TriageInput, "onProgress">) => {
      controller.current = new AbortController();
      return run(
        Effect.flatMap(Intake, (i) => i.triage({ ...input, onProgress: setProgress })),
        controller.current.signal,
      );
    },
    onSuccess: (r) => {
      toast.success(
        r.proposals || r.questions
          ? `${r.proposals} proposal${r.proposals === 1 ? "" : "s"}${r.questions ? ` and ${r.questions} question${r.questions === 1 ? "" : "s"}` : ""} to review`
          : "Nothing to do in that input",
      );
      onDone?.(r.inboxItemId);
    },
    onError: (e) => {
      // A cancel is the user's choice, not an error.
      if ((e as { _tag?: string })._tag !== "InterruptedException") onError(e);
    },
    onSettled: () => {
      setProgress(null);
      invalidate();
    },
  });
  return { ...mutation, progress, cancel: () => controller.current?.abort() };
}

function useProposalMutation<A, I>(
  f: (p: Proposals["Type"], input: I) => Effect.Effect<A, unknown>,
) {
  const onError = useErrorToast();
  const invalidate = useInvalidateAfterDecision();
  return useMutation({
    mutationFn: (input: I) =>
      run(Effect.flatMap(Proposals, (p) => f(p, input)) as Effect.Effect<A, unknown, never>),
    onError: (e) => onError(e),
    onSettled: invalidate,
  });
}

export function useDecisions() {
  const onError = useErrorToast();
  const invalidate = useInvalidateAfterDecision();
  const approve = useProposalMutation((p, i: { id: string; edited?: ProposalPayload }) =>
    p.approve(i.id, i.edited),
  );
  const reject = useProposalMutation((p, id: string) => p.reject(id));
  const approveAll = useProposalMutation((p, inboxItemId: string) => p.approveAll(inboxItemId));
  const dismiss = useProposalMutation((p, inboxItemId: string) => p.dismiss(inboxItemId));
  const retriage = useMutation({
    mutationFn: (inboxItemId: string) =>
      run(Effect.flatMap(Intake, (i) => i.retriage(inboxItemId))),
    onError: (e) => onError(e),
    onSettled: invalidate,
  });
  return { approve, reject, approveAll, dismiss, retriage };
}

/** Names for keys and ids shown on proposal cards. */
export function useLookups() {
  const tickets = useQuery({
    queryKey: queryKeys.ticketRows,
    queryFn: ({ signal }) => run(listTicketRows, signal),
  });
  const people = useQuery({
    queryKey: queryKeys.people,
    queryFn: ({ signal }) => run(listPeople, signal),
  });
  const teams = useQuery({
    queryKey: queryKeys.teams,
    queryFn: ({ signal }) => run(listTeams, signal),
  });
  return useMemo(
    () => ({
      issue: new Map((tickets.data ?? []).map((t) => [t.key, t])),
      person: new Map((people.data ?? []).map((p) => [p.id, p])),
      team: new Map((teams.data ?? []).map((t) => [t.id, t])),
      people: people.data ?? [],
      teams: teams.data ?? [],
      tickets: tickets.data ?? [],
    }),
    [tickets.data, people.data, teams.data],
  );
}
export type Lookups = ReturnType<typeof useLookups>;

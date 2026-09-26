import { useMutation, useQuery } from "@tanstack/react-query";
import { Effect, Option } from "effect";
import { useRef } from "react";
import { useAppMutation } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { Planning, type PlanningShape, type PlanToPropose } from "@/services/planning";

/**
 * Calls the Planning service. `serviceOption` keeps this page independent of
 * the order layers are wired in the runtime; a missing layer is a defect.
 */
const withPlanning = <A, E>(f: (p: PlanningShape) => Effect.Effect<A, E>) =>
  Effect.flatMap(Effect.serviceOption(Planning), (p) =>
    Option.match(p, {
      onNone: () => Effect.dieMessage("The planning service is not available"),
      onSome: f,
    }),
  );

/** The sprint pair, velocity and candidates for today. */
export function usePlanPrep({ staleTime }: { staleTime?: number } = {}) {
  return useQuery({
    queryKey: queryKeys.planPrep,
    queryFn: ({ signal }) =>
      run(
        withPlanning((p) => p.prepare()),
        signal,
      ),
    staleTime,
  });
}

/** Asks the model for a plan; long-running, so it can be cancelled. */
export function useDraftPlan() {
  const controller = useRef<AbortController | null>(null);
  const mutation = useMutation({
    mutationFn: (input: { capacity: number | null; instructions: string[] }) => {
      controller.current = new AbortController();
      return run(
        withPlanning((p) => p.draft(input)),
        controller.current.signal,
      );
    },
  });
  return { ...mutation, cancel: () => controller.current?.abort() };
}

type Proposed = { inboxItemId: string; proposals: number; alreadyThere: string[] };

/** Turns the reviewed plan into proposals in a new Inbox thread; errors show inline. */
export function useProposePlan(opts: {
  success: (r: Proposed) => string;
  onSuccess: (r: Proposed) => void;
}) {
  return useAppMutation((plan: PlanToPropose) => withPlanning((p) => p.propose(plan)), {
    invalidate: [queryKeys.inbox, queryKeys.planning],
    toastError: false,
    ...opts,
  });
}

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Effect } from "effect";
import { toast } from "sonner";
import { useErrorToast } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { type AppServices, run } from "@/app/runtime";
import { dashboardWithBrief, generateBrief } from "@/services/dashboard/brief";

export function useDashboard() {
  return useQuery({
    queryKey: queryKeys.dashboard,
    queryFn: ({ signal }) => run(dashboardWithBrief(), signal),
    // Relative dates ("due in 2 days") should roll over while the app stays open.
    refetchInterval: 5 * 60 * 1000,
  });
}

export function useGenerateBrief() {
  const client = useQueryClient();
  const onError = useErrorToast();
  return useMutation({
    mutationFn: () => run(generateBrief()),
    onSuccess: () => void client.invalidateQueries({ queryKey: queryKeys.dashboard }),
    onError: (e) => onError(e),
  });
}

/** Local ticket state change (pin, snooze, override); refreshes rankings. */
export function useMetaMutation<I>(
  program: (input: I) => Effect.Effect<unknown, unknown, AppServices>,
  success: string,
) {
  const client = useQueryClient();
  const onError = useErrorToast();
  return useMutation({
    mutationFn: (input: I) => run(program(input)),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.tickets });
      toast.success(success);
    },
    onError: (e) => onError(e),
  });
}

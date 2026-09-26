import { useQuery } from "@tanstack/react-query";
import type { Effect } from "effect";
import { useAppMutation } from "@/app/hooks";
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
  return useAppMutation((days: number | null = null) => generateBrief(new Date(), days), {
    invalidate: [queryKeys.dashboard],
  });
}

/** Local ticket state change (pin, snooze, override); refreshes rankings. */
export function useMetaMutation<I>(
  program: (input: I) => Effect.Effect<unknown, unknown, AppServices>,
  success: string,
) {
  return useAppMutation(program, { invalidate: [queryKeys.tickets], success });
}

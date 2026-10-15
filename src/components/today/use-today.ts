import { useQuery } from "@tanstack/react-query";
import type { Effect } from "effect";
import { toast } from "sonner";
import { useAppMutation } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { type AppServices, run } from "@/app/runtime";
import type { ActionResult } from "@/services/dashboard/actions";
import { generateBrief, todayWithBrief } from "@/services/dashboard/brief";

/** Today's lists and the cached brief (D49). */
export function useToday() {
  return useQuery({
    queryKey: queryKeys.today,
    queryFn: ({ signal }) => run(todayWithBrief(), signal),
    // Relative dates ("due tomorrow") should roll over while the app stays open.
    refetchInterval: 5 * 60 * 1000,
  });
}

export function useGenerateBrief() {
  return useAppMutation(() => generateBrief(), { invalidate: [queryKeys.today] });
}

/** What Today's writes can change: tickets (Today is under them), waits and the Inbox. */
const TODAY_KEYS = [queryKeys.tickets, queryKeys.dependencies, queryKeys.inbox] as const;

/** Local ticket state change (pin, snooze, override); refreshes Today and rankings. */
export function useMetaMutation<I>(
  program: (input: I) => Effect.Effect<unknown, unknown, AppServices>,
  success: string | ((a: unknown, input: I) => string),
) {
  return useAppMutation(program, { invalidate: TODAY_KEYS, success });
}

/**
 * A row action that reports what happened (D49): a toast with the result and
 * any warning, then the lists refresh. Failures toast with Jira's message. A
 * Jira write can partly apply, so the lists refresh after a failure too.
 */
export function useRowAction<I>(
  program: (input: I) => Effect.Effect<ActionResult, unknown, AppServices>,
  opts: {
    onSuccess?: (r: ActionResult, input: I) => void;
    /** False when the caller toasts the error itself (the sweep, with a Retry). */
    toastError?: boolean;
  } = {},
) {
  return useAppMutation(program, {
    invalidate: TODAY_KEYS,
    invalidateOnError: true,
    toastError: opts.toastError ?? true,
    onSuccess: (r, input) => {
      if (r.warning) toast.warning(r.message, { description: r.warning });
      else toast.success(r.message);
      opts.onSuccess?.(r, input);
    },
  });
}

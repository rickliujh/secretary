/**
 * Sprint fit reads for the Inbox, Today and Settings (D57). Keys sit under
 * "tickets", so a sync and every decision (proposal edits included) refresh
 * them; the rate setting is part of the key, so changing it does too.
 */
import { useQuery } from "@tanstack/react-query";
import { useSettings } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { localDate } from "@/lib/dates";
import { threadSprintFits, userSprintLoad } from "@/services/sprints/fit-query";

const useDaysPerPoint = () => useSettings().data?.sprint.daysPerPoint ?? null;

/** The sprint choice of each open create in a thread, by proposal id. */
export function useThreadSprintFits(inboxItemId: string | null, enabled = true) {
  const perPoint = useDaysPerPoint();
  return useQuery({
    queryKey: queryKeys.sprintFit(inboxItemId ?? "", perPoint),
    queryFn: ({ signal }) => run(threadSprintFits(inboxItemId ?? "", localDate()), signal),
    enabled: enabled && !!inboxItemId,
  });
}

/** The user's sprint and its load without a new ticket (Today, Settings). */
export function useUserSprintLoad() {
  const perPoint = useDaysPerPoint();
  return useQuery({
    queryKey: queryKeys.sprintLoad(perPoint),
    queryFn: ({ signal }) => run(userSprintLoad(localDate()), signal),
  });
}

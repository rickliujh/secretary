/**
 * Sprint fit reads for the Inbox, Today and Settings (D57). Keys sit under
 * "tickets", so a sync and every decision (proposal edits included) refresh
 * them; the rate setting and the local date are part of the key, so changing
 * a setting or a new day (seen when the window gets focus again) does too.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useSettings } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { localDate } from "@/lib/dates";
import { threadSprintFits, userSprintLoad } from "@/services/sprints/fit-query";

/** The sprint settings the fit reads (rate and last day), for the query keys. */
const useSprintSettings = () => {
  const sprint = useSettings().data?.sprint;
  return [sprint?.daysPerPoint ?? null, sprint?.lastDay ?? "jira"] as const;
};

/** Today's local date, read again when the window gets focus or every few minutes. */
function useLocalDate() {
  const [today, setToday] = useState(localDate);
  useEffect(() => {
    const check = () => setToday(localDate());
    window.addEventListener("focus", check);
    const timer = setInterval(check, 5 * 60 * 1000);
    return () => {
      window.removeEventListener("focus", check);
      clearInterval(timer);
    };
  }, []);
  return today;
}

/** The sprint choice of each open create in a thread, by proposal id. */
export function useThreadSprintFits(inboxItemId: string | null, enabled = true) {
  const settings = useSprintSettings();
  const today = useLocalDate();
  return useQuery({
    queryKey: queryKeys.sprintFit(inboxItemId ?? "", settings, today),
    queryFn: ({ signal }) => run(threadSprintFits(inboxItemId ?? "", today), signal),
    enabled: enabled && !!inboxItemId,
    refetchOnWindowFocus: true,
  });
}

/** The user's sprint and its load without a new ticket (Today, Settings). */
export function useUserSprintLoad() {
  const settings = useSprintSettings();
  const today = useLocalDate();
  return useQuery({
    queryKey: queryKeys.sprintLoad(settings, today),
    queryFn: ({ signal }) => run(userSprintLoad(today), signal),
    refetchOnWindowFocus: true,
  });
}

/**
 * Sprint fit reads for the Inbox, Today, Settings and the ticket view's Edit
 * dialog (D57, D58). Keys sit under "tickets", so a sync and every decision
 * (proposal edits included) refresh them; the rate setting and the local date
 * are part of the key, so changing a setting or a new day (seen when the
 * window gets focus again) does too.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useSettings } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { localDate } from "@/lib/dates";
import type { FitTicket } from "@/services/sprints/fit";
import {
  knownSprints,
  threadSprintFits,
  ticketJoinSprint,
  ticketSprintFit,
  userSprintLoad,
} from "@/services/sprints/fit-query";

/** The sprint settings the fit reads (rate and last day), for the query keys. */
const useSprintSettings = () => {
  const sprint = useSettings().data?.sprint;
  return [sprint?.daysPerPoint ?? null, sprint?.lastDay ?? "jira"] as const;
};

/** Today's local date, read again when the window gets focus or every few minutes. */
export function useLocalDate() {
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

/** The synced sprints, for the Edit dialog's Sprint select (D58). */
export function useKnownSprints(enabled = true) {
  return useQuery({
    queryKey: queryKeys.knownSprints,
    queryFn: ({ signal }) => run(knownSprints, signal),
    enabled,
  });
}

/** The sprint the Edit dialog's switch joins for a ticket of `projectKey` (D58). */
export function useTicketJoinSprint(projectKey: string, enabled: boolean) {
  const settings = useSprintSettings();
  const today = useLocalDate();
  return useQuery({
    queryKey: queryKeys.ticketJoinSprint(projectKey, settings, today),
    queryFn: ({ signal }) => run(ticketJoinSprint(projectKey, today), signal),
    enabled,
    refetchOnWindowFocus: true,
  });
}

/**
 * An existing ticket's fit in an active sprint it would move into from the
 * Edit dialog (D58), with the dialog's points. Off without a sprint; the last
 * fit stays shown while the next one is read, so typing points does not flicker.
 */
export function useTicketSprintFit(
  issueKey: string,
  currentSprint: string | null,
  sprintId: number | null,
  ticket: FitTicket,
) {
  const settings = useSprintSettings();
  const today = useLocalDate();
  return useQuery({
    queryKey: queryKeys.ticketSprintFit(
      issueKey,
      currentSprint,
      sprintId ?? 0,
      ticket.points,
      settings,
      today,
    ),
    queryFn: ({ signal }) =>
      run(ticketSprintFit(sprintId ?? 0, ticket, today, currentSprint), signal),
    enabled: sprintId !== null,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: true,
  });
}

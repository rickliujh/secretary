/**
 * Shared read queries used by several pages, so each list has one query
 * function and one cache entry.
 */
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { listPeople, listTeams } from "@/services/directory/queries";
import { pendingCount } from "@/services/inbox/queries";
import { usageSince } from "@/services/llm/usage";
import { listTicketRows } from "@/services/tickets/queries";
import { queryKeys } from "./query-client";
import { run, SESSION_STARTED_AT } from "./runtime";

type ListOptions = { enabled?: boolean };

export function usePeople({ enabled }: ListOptions = {}) {
  return useQuery({
    queryKey: queryKeys.people,
    queryFn: ({ signal }) => run(listPeople, signal),
    enabled,
  });
}

export function useTeams({ enabled }: ListOptions = {}) {
  return useQuery({
    queryKey: queryKeys.teams,
    queryFn: ({ signal }) => run(listTeams, signal),
    enabled,
  });
}

export function useTicketRows({ enabled }: ListOptions = {}) {
  return useQuery({
    queryKey: queryKeys.ticketRows,
    queryFn: ({ signal }) => run(listTicketRows, signal),
    enabled,
  });
}

/** Proposals waiting for a decision, for the Inbox badge and the dashboard. */
export function usePendingCount({ refetchInterval }: { refetchInterval?: number } = {}) {
  return useQuery({
    queryKey: queryKeys.pendingCount,
    queryFn: ({ signal }) => run(pendingCount, signal),
    refetchInterval,
  });
}

/** Model usage since the app started. */
export function useSessionUsage({ refetchInterval }: { refetchInterval?: number } = {}) {
  return useQuery({
    queryKey: queryKeys.usage,
    queryFn: ({ signal }) => run(usageSince(SESSION_STARTED_AT), signal),
    refetchInterval,
  });
}

/** Names for keys and ids shown on proposal cards. */
export function useLookups() {
  const tickets = useTicketRows();
  const people = usePeople();
  const teams = useTeams();
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

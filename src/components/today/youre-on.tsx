/**
 * "You're on" (FR-19.8, D62): while a work item is current, a panel at the
 * top of Today with its name, current step, what is expected next and its
 * next moves. It is the current item's summary: its moves are listed even
 * when the lists below show them too, and the rows stay where they are. One
 * click opens the item's ticket, one click clears current.
 */
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Star, X } from "lucide-react";
import { useAppMutation, useSettings } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { requestWorkPass } from "@/app/work";
import { useTicketPanel } from "@/components/tickets/ticket-link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { NextMoves } from "@/components/work/next-moves";
import { localDate } from "@/lib/dates";
import { shortDate } from "@/lib/time";
import { NEXT_LIMIT } from "@/services/work/next";
import { currentWork } from "@/services/work/next-query";
import { setCurrent } from "@/services/work/queries";

export function YoureOn() {
  const { data: settings } = useSettings();
  const on = (settings?.secretary.suggestions ?? false) && (settings?.work.enabled ?? false);
  const day = localDate();
  const work = useQuery({
    queryKey: queryKeys.currentWork(day),
    queryFn: ({ signal }) => run(currentWork(day), signal),
    enabled: on,
  });
  const openTicket = useTicketPanel();
  const clear = useAppMutation(() => setCurrent(null), {
    invalidate: [queryKeys.tickets, queryKeys.inbox],
    // Parked threads come back when current changes (D62).
    onSuccess: requestWorkPass,
  });
  const w = work.data;
  if (!on || !w) return null;
  const moves = w.moves.slice(0, NEXT_LIMIT);
  return (
    <Card className="gap-3 py-4">
      <CardHeader className="px-4">
        <CardDescription className="flex items-center gap-1">
          <Star className="size-3.5 fill-current" /> You're on
        </CardDescription>
        <CardTitle className="text-base">{w.name}</CardTitle>
        <CardAction className="flex gap-2">
          {w.issueKey && (
            <Button size="sm" variant="outline" onClick={() => openTicket(w.issueKey)}>
              <ExternalLink /> Open {w.issueKey}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={clear.isPending}
            onClick={() => clear.mutate(undefined)}
          >
            <X /> Not on it now
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 px-4 text-sm">
        {(w.currentStep || w.nextExpected) && (
          <div className="flex flex-col gap-0.5">
            {w.currentStep && <p>Now: {w.currentStep}</p>}
            {w.nextExpected && (
              <p className="text-muted-foreground">
                Next expected: {w.nextExpected.what}
                {w.nextExpected.on ? ` (${shortDate(w.nextExpected.on)})` : ""}
              </p>
            )}
          </div>
        )}
        <NextMoves
          moves={moves}
          empty={w.currentStep || w.nextExpected ? undefined : "Nothing due on this yet."}
        />
      </CardContent>
    </Card>
  );
}

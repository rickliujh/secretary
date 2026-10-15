import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChartNoAxesColumn, RefreshCw } from "lucide-react";
import { describeError } from "@/app/errors";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { EmptyState, PageHeader } from "@/components/page";
import { TicketLink } from "@/components/tickets/ticket-link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { loadEpicHealth } from "@/services/dashboard/data";
import type { EpicHealth as EpicHealthRow } from "@/services/dashboard/sections";

/** Sprint > Epics (D50): the epic health rollup that was on the old dashboard. */
export function EpicsPage() {
  const epics = useQuery({
    queryKey: queryKeys.epicHealth,
    queryFn: ({ signal }) => run(loadEpicHealth(), signal),
  });
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <PageHeader
        title="Epics"
        description="Each tracked epic's children: done, in progress and to do, with blocked and stale counts."
      />
      {epics.isPending ? (
        <Skeleton className="h-40" />
      ) : epics.isError ? (
        <EmptyState
          icon={ChartNoAxesColumn}
          title={describeError(epics.error).title}
          description={describeError(epics.error).description ?? "Epic health could not load."}
          action={
            <Button variant="outline" onClick={() => void epics.refetch()}>
              <RefreshCw /> Retry
            </Button>
          }
        />
      ) : (
        <Card size="sm">
          <CardContent>
            <EpicHealth epics={epics.data} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** Per tracked epic: done / in progress / to do, plus blocked and stale counts (FR-5.1). */
export function EpicHealth({ epics }: { epics: EpicHealthRow[] }) {
  if (epics.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No tracked epics. Add them in{" "}
        <Link to="/settings" search={{ tab: "jira" }} className="underline">
          Settings &gt; Jira
        </Link>
        .
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-3">
      {epics.map((e) => {
        const pct = (n: number) => (e.total ? `${(n / e.total) * 100}%` : "0%");
        return (
          <li key={e.key} className="flex flex-col gap-1">
            <div className="flex items-center gap-2 text-sm">
              <TicketLink ticketKey={e.key} className="font-mono text-xs underline">
                {e.key}
              </TicketLink>
              <span className="min-w-0 flex-1 truncate">
                {e.epic?.summary ?? "Not in the local cache"}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {e.done}/{e.total} done
              </span>
            </div>
            <div
              className="flex h-2 overflow-hidden rounded-full bg-muted"
              role="img"
              aria-label={`${e.done} done, ${e.inProgress} in progress, ${e.todo} to do`}
            >
              <div className="bg-emerald-500" style={{ width: pct(e.done) }} />
              <div className="bg-blue-500" style={{ width: pct(e.inProgress) }} />
            </div>
            <p className="text-xs text-muted-foreground">
              {e.inProgress} in progress · {e.todo} to do
              {e.blocked > 0 && <span className="text-destructive"> · {e.blocked} blocked</span>}
              {e.stale > 0 && (
                <span className="text-amber-600 dark:text-amber-400"> · {e.stale} stale</span>
              )}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

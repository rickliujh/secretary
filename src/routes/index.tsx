import { createFileRoute } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { QuickThread } from "@/components/inbox/quick-thread";
import { BriefButton } from "@/components/today/brief";
import { SprintWork, TheirMove, YourMove } from "@/components/today/lists";
import { PlanCard } from "@/components/today/plan-card";
import { SweepButton } from "@/components/today/sweep";
import { useToday } from "@/components/today/use-today";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({ component: TodayPage });

/**
 * Today (FR-12, D49): a capture box and three lists, one per question: what is
 * my move, what is theirs, what is planned. The sweep and the brief open from
 * the header; the plan banner shows near a sprint's end.
 */
function TodayPage() {
  const { data, isPending, refetch, isRefetching } = useToday();

  if (isPending) return <Loader2 className="m-6 animate-spin text-muted-foreground" />;
  // A failed refresh keeps the last lists (and an open sweep) on screen.
  if (!data)
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        Today could not be loaded.
        <Button variant="outline" size="sm" disabled={isRefetching} onClick={() => void refetch()}>
          Retry
        </Button>
      </div>
    );
  const t = data.today;

  return (
    <div className="@container mx-auto flex max-w-7xl flex-col gap-4">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-lg font-semibold">Today</h1>
        <p className="text-sm text-muted-foreground tabular-nums">
          {t.yourMove.length} your move · {t.theirMove.length} their move · {t.sprintWork.length}{" "}
          sprint work
        </p>
        <div className="ml-auto flex items-center gap-2">
          <SweepButton today={t} />
          <BriefButton brief={data.brief} fresh={data.briefFresh} />
        </div>
      </header>
      <PlanCard />
      <QuickThread />
      <div className="grid items-start gap-4 @4xl:grid-cols-3">
        <YourMove today={t} />
        <TheirMove today={t} />
        <SprintWork today={t} />
      </div>
    </div>
  );
}

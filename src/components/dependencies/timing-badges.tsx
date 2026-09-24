import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { DependencyTiming } from "@/services/dependencies/logic";

export function TimingBadges({
  timing,
  expectedAt,
  nextFollowupAt,
}: {
  timing: DependencyTiming;
  expectedAt: string | null;
  nextFollowupAt: string | null;
}) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {timing.overdueDays > 0 ? (
        <Badge variant="destructive" className="tabular-nums">
          {timing.overdueDays} day{timing.overdueDays === 1 ? "" : "s"} overdue
        </Badge>
      ) : expectedAt ? (
        <Badge variant="outline" className="tabular-nums">
          due {expectedAt}
        </Badge>
      ) : null}
      {timing.followupDue && (
        <Badge
          variant="secondary"
          className={cn("border-transparent bg-amber-500/15 text-amber-700 dark:text-amber-300")}
        >
          {timing.followupLateDays > 0
            ? `follow up (${timing.followupLateDays}d late)`
            : "follow up today"}
        </Badge>
      )}
      {!timing.followupDue && nextFollowupAt && (
        <span className="text-xs text-muted-foreground tabular-nums">
          next chase {nextFollowupAt}
        </span>
      )}
    </span>
  );
}

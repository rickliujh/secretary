import { TONE } from "@/components/tone";
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
  // The owner is away (D47): the wait sleeps until they are back.
  if (timing.asleep)
    return (
      <span className="flex flex-wrap items-center gap-1">
        <Badge variant="outline" className="tabular-nums">
          {timing.reason ?? `away until ${timing.awayUntil}`}
        </Badge>
        <span className="text-xs text-muted-foreground tabular-nums">
          follow up {timing.followupOn}
        </span>
      </span>
    );
  return (
    <span className="flex flex-wrap items-center gap-1">
      {timing.backSince && (
        <Badge variant="secondary" className={cn("border-transparent", TONE.info)}>
          {timing.reason}
        </Badge>
      )}
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
        <Badge variant="secondary" className={cn("border-transparent", TONE.warning)}>
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

import { Badge } from "@/components/ui/badge";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import type { DependencyTiming } from "@/services/dependencies/logic";
import type { DependencyRow as Row } from "@/services/dependencies/queries";
import { TimingBadges } from "./timing-badges";

export function DependencyRowView({
  dep,
  timing,
  onOpen,
  showIssue = true,
}: {
  dep: Row;
  timing: DependencyTiming;
  onOpen: () => void;
  showIssue?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        "flex w-full flex-col gap-1 rounded-md px-3 py-2 text-left hover:bg-muted",
        dep.status === "resolved" && "opacity-60",
      )}
    >
      <span className="flex flex-wrap items-center gap-2 text-sm">
        {showIssue && <span className="font-mono text-xs">{dep.issueKey}</span>}
        <span className="font-medium">{dep.label}</span>
        {dep.externalRef && (
          <span className="font-mono text-xs text-muted-foreground">{dep.externalRef}</span>
        )}
        <Badge variant="outline">{dep.status}</Badge>
        {dep.mirrorRemoteLinkId && <Badge variant="secondary">in Jira</Badge>}
      </span>
      {showIssue && dep.issueSummary && (
        <span className="truncate text-xs text-muted-foreground">{dep.issueSummary}</span>
      )}
      <span className="flex flex-wrap items-center gap-3">
        <TimingBadges
          timing={timing}
          expectedAt={dep.expectedAt}
          nextFollowupAt={dep.nextFollowupAt}
        />
        <span className="text-xs text-muted-foreground">
          {dep.lastFollowupAt
            ? `last chased ${relativeTime(dep.lastFollowupAt)}`
            : "not chased yet"}
        </span>
      </span>
    </button>
  );
}

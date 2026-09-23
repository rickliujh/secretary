import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { useErrorToast, useSettings } from "@/app/hooks";
import { runSync, useSyncStatus } from "@/app/sync";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { relativeTime } from "@/lib/time";

export function SyncIndicator() {
  const status = useSyncStatus();
  const { data: settings } = useSettings();
  const onError = useErrorToast();
  if (!settings?.jira.baseUrl) return null;

  const sync = () =>
    runSync().catch((e) => {
      if ((e as { kind?: string }).kind !== "busy") onError(e, sync);
    });

  let label = "Not synced";
  if (status?.running)
    label = status.total
      ? `Syncing ${status.fetched}/${status.total}`
      : (status.phase ?? "Syncing");
  else if (status?.lastError) label = "Sync failed";
  else if (status?.lastSyncAt) label = `Synced ${relativeTime(status.lastSyncAt)}`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={
            status?.lastError && !status.running ? "text-destructive" : "text-muted-foreground"
          }
          onClick={sync}
          disabled={status?.running}
        >
          {status?.running ? (
            <Loader2 className="animate-spin" />
          ) : status?.lastError ? (
            <AlertTriangle />
          ) : (
            <RefreshCw />
          )}
          <span className="tabular-nums">{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs">
        {status?.lastError ? (
          <p>{status.lastError}</p>
        ) : status?.lastResult ? (
          <p>
            Last {status.lastResult.full ? "full" : "incremental"} sync: {status.lastResult.fetched}{" "}
            issues in {(status.lastResult.durationMs / 1000).toFixed(1)}s.
          </p>
        ) : (
          <p>Sync Jira now.</p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

import { Link } from "@tanstack/react-router";
import type { Dashboard } from "@/services/dashboard/sections";

/** Per tracked epic: done / in progress / to do, plus blocked and stale counts (FR-5.1). */
export function EpicHealth({ epics }: { epics: Dashboard["epicHealth"] }) {
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
              <Link to="/tickets" search={{ key: e.key }} className="font-mono text-xs underline">
                {e.key}
              </Link>
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

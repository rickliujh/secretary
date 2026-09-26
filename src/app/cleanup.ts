/**
 * Background storage cleanup (D34): shortly after launch and then daily while
 * the app is open. `cleanupIfDue` skips when the last run was recent, so
 * restarts do not repeat it.
 */
import { useEffect } from "react";
import { pruneImportBackups } from "@/services/data/backups";
import { cleanup, cleanupIfDue } from "@/services/data/retention";
import { queryClient, queryKeys } from "./query-client";
import { run } from "./runtime";
import { syncRunning } from "./sync";

const STARTUP_DELAY_MS = 60_000;
const RETRY_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export async function runCleanup(force = false) {
  const result = await run(force ? cleanup() : cleanupIfDue());
  if (result) await pruneImportBackups().catch(() => 0);
  void queryClient.invalidateQueries({ queryKey: queryKeys.storage });
  return result;
}

export function useCleanupScheduler() {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      // A sync holds the database; try again a little later.
      if (syncRunning()) {
        timer = setTimeout(tick, RETRY_MS);
        return;
      }
      void runCleanup().catch(() => undefined);
      timer = setTimeout(tick, DAY_MS);
    };
    timer = setTimeout(tick, STARTUP_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);
}

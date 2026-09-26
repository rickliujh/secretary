/**
 * React bindings for the Sync service: live status and the background timer
 * (FR-1.3).
 */
import { Effect, Stream } from "effect";
import { useEffect, useSyncExternalStore } from "react";
import { Sync, type SyncStatus } from "@/services/sync";
import { useSettings } from "./hooks";
import { queryClient, queryKeys } from "./query-client";
import { run, runtime } from "./runtime";

let current: SyncStatus | null = null;
const listeners = new Set<() => void>();
let started = false;

function start() {
  if (started) return;
  started = true;
  runtime.runFork(
    Effect.flatMap(Sync, (sync) =>
      Stream.runForEach(sync.changes, (status) =>
        Effect.sync(() => {
          const finished = current?.running && !status.running;
          current = status;
          for (const l of listeners) l();
          // New data after every run, successful or partial.
          if (finished) void queryClient.invalidateQueries({ queryKey: queryKeys.tickets });
        }),
      ),
    ),
  );
}

export function useSyncStatus(): SyncStatus | null {
  return useSyncExternalStore(
    (listener) => {
      start();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

export const runSync = (full = false) => run(Effect.flatMap(Sync, (s) => s.run({ full })));

const STARTUP_DELAY_MS = 3000;

/** Syncs shortly after launch and then every `syncIntervalMinutes` while the app is open. */
export function useSyncScheduler() {
  const { data: settings } = useSettings();
  const configured = !!settings?.jira.baseUrl;
  const minutes = settings?.jira.syncIntervalMinutes ?? 10;
  useEffect(() => {
    if (!configured) return;
    // Failures show in the sync indicator; the timer keeps going. Offline, cached
    // data stays usable and the next run waits for the network to return.
    const tick = () => {
      if (navigator.onLine) void runSync().catch(() => undefined);
    };
    const first = setTimeout(tick, STARTUP_DELAY_MS);
    const every = setInterval(tick, minutes * 60 * 1000);
    window.addEventListener("online", tick);
    return () => {
      clearTimeout(first);
      clearInterval(every);
      window.removeEventListener("online", tick);
    };
  }, [configured, minutes]);
}

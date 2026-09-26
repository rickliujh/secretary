/**
 * Data sources (D41): index runs from the webview, one at a time, and the
 * background schedule (shortly after launch, every 15 minutes, and after the
 * sources in settings change).
 */
import { Effect } from "effect";
import { useEffect, useRef } from "react";
import type { DataSource } from "@/services/settings";
import { Sources } from "@/services/sources";
import { useSettings } from "./hooks";
import { queryClient, queryKeys } from "./query-client";
import { run } from "./runtime";

const STARTUP_DELAY_MS = 20_000;
const INTERVAL_MS = 15 * 60_000;
const MAX_AGE_MS = 10 * 60_000;
const CHANGE_DEBOUNCE_MS = 1500;

// Runs queue behind each other, so a settings change, a timer tick and a
// Re-index click never walk the same folder at once.
let queue: Promise<unknown> = Promise.resolve();

function enqueue<A>(task: () => Promise<A>): Promise<A> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next.finally(() => void queryClient.invalidateQueries({ queryKey: queryKeys.sources }));
}

/** Brings the index up to date (one source, or all); removed sources lose their rows. */
export const indexSources = (opts?: { sourceId?: string; force?: boolean }) =>
  enqueue(() => run(Effect.flatMap(Sources, (s) => s.index(opts))));

/** Index when the last run is older than `maxAgeMs`; failures are recorded in the status. */
export const indexSourcesIfStale = (maxAgeMs = MAX_AGE_MS) =>
  enqueue(() => run(Effect.flatMap(Sources, (s) => s.indexIfStale(maxAgeMs))));

/** What in a source changes the index: the folder, whether it is on, and what it leaves out. */
const indexKey = (sources: readonly DataSource[]) =>
  JSON.stringify(sources.map((s) => [s.id, s.path, s.enabled, s.exclude]));

/** Keeps the note index fresh while the app is open. */
export function useSourceIndexing() {
  const { data: settings } = useSettings();
  const sources = settings?.dataSources;
  const anyEnabled = !!sources?.some((s) => s.enabled);

  useEffect(() => {
    if (!anyEnabled) return;
    const tick = () => void indexSourcesIfStale().catch(() => undefined);
    const first = setTimeout(tick, STARTUP_DELAY_MS);
    const every = setInterval(tick, INTERVAL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [anyEnabled]);

  // After an edit in Settings, re-index; the first load is not a change. A run
  // also follows the last source being turned off or removed, so its rows go.
  const key = sources ? indexKey(sources) : null;
  const previous = useRef<string | null>(null);
  useEffect(() => {
    if (key === null) return;
    const before = previous.current;
    previous.current = key;
    if (before === null || before === key) return;
    const timer = setTimeout(() => void indexSources().catch(() => undefined), CHANGE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [key]);
}

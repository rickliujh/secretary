/**
 * The work pass in the webview (D61): requested after a sync, a triage, an
 * approval or a revoke, run at most once a minute on the app's own runtime. No
 * extra process: it runs while the app is open, like sync and reminders.
 */
import { useEffect } from "react";
import { logger } from "@/lib/log";
import { runWorkPass } from "@/services/work/pass";
import { useSettings } from "./hooks";
import { queryClient, queryKeys } from "./query-client";
import { run } from "./runtime";
import { PassScheduler } from "./work-scheduler";

let enabled = false;

const scheduler = new PassScheduler(async () => {
  if (!enabled) return;
  try {
    const r = await run(runWorkPass());
    if (r.created || r.attached || r.calls || r.asked || r.offered || r.returned) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tickets });
      void queryClient.invalidateQueries({ queryKey: queryKeys.inbox });
    }
  } catch (e) {
    logger.warn("Work pass failed", e);
  }
});

/**
 * With the work model off nothing is current, so parked Inbox threads come
 * back (D62): the pass's cheap "off" branch, run at launch and when the
 * switch turns off. It makes no model call and groups nothing.
 */
async function returnParkedWhileOff() {
  try {
    const r = await run(runWorkPass());
    if (r.returned) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.tickets });
      void queryClient.invalidateQueries({ queryKey: queryKeys.inbox });
    }
  } catch (e) {
    logger.warn("Returning parked threads failed", e);
  }
}

/** Asks for a work pass; cheap to call often, it runs at most once a minute. */
export function requestWorkPass() {
  if (enabled) scheduler.request();
}

/** Keeps the scheduler in step with Settings > Secretary; mounted once at the root. */
export function useWorkPass() {
  const { data: settings } = useSettings();
  const loaded = !!settings;
  const on = settings?.work.enabled ?? false;
  useEffect(() => {
    enabled = on;
    if (!on) {
      scheduler.cancel();
      // Only once the settings say so: before they load, "off" is not known.
      if (loaded) void returnParkedWhileOff();
      return;
    }
    // A first pass shortly after launch picks up what changed while the app was closed.
    scheduler.request();
    return () => scheduler.cancel();
  }, [on, loaded]);
}

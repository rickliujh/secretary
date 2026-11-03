/**
 * The work pass in the webview (D61): requested after a sync, a triage, an
 * approval or a revoke, run at most once a minute on the app's own runtime. No
 * extra process: it runs while the app is open, like sync and reminders.
 *
 * The end-of-day pass (D63) runs here too: from Today's button, and at the
 * time Settings > Secretary sets, once a local day, only while the app is open.
 */
import { useEffect } from "react";
import { logger } from "@/lib/log";
import { type DayEndResult, runDayEnd } from "@/services/work/dayend-query";
import { runWorkPass } from "@/services/work/pass";
import { useSettings } from "./hooks";
import { queryClient, queryKeys } from "./query-client";
import { run } from "./runtime";
import { DailyTrigger, PassScheduler } from "./work-scheduler";

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

let dayEndRunning: Promise<DayEndResult> | null = null;

/**
 * Runs the end-of-day pass now (Today's button, or the set time): one run at a
 * time; a second ask while one runs gets its result.
 */
export function runDayEndNow(trigger: "button" | "time" = "button"): Promise<DayEndResult> {
  if (dayEndRunning) return dayEndRunning;
  const running = run(runDayEnd({ trigger })).then((r) => {
    if (!r.skipped) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.inbox });
      void queryClient.invalidateQueries({ queryKey: queryKeys.tickets });
    }
    return r;
  });
  dayEndRunning = running;
  void running
    .catch(() => undefined)
    .finally(() => {
      if (dayEndRunning === running) dayEndRunning = null;
    });
  return running;
}

const dayEndTrigger = new DailyTrigger(async () => {
  try {
    await runDayEndNow("time");
  } catch (e) {
    logger.warn("End-of-day pass failed", e);
  }
});

/**
 * Keeps the timed end-of-day pass in step with Settings > Secretary; mounted
 * once at the root. Off while the work model is off.
 */
export function useDayEnd() {
  const { data: settings } = useSettings();
  const on = (settings?.work.enabled ?? false) && (settings?.secretary.dayEnd.enabled ?? false);
  const at = settings?.secretary.dayEnd.at ?? "";
  useEffect(() => {
    if (!on) return;
    dayEndTrigger.start(at);
    return () => dayEndTrigger.stop();
  }, [on, at]);
}

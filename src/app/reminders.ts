/**
 * OS notifications when dependency follow-ups fall due (FR-3.5) and, once per
 * ticket, when a ticket's last blocker closed (FR-3.8, D45).
 */
import { isTauri } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { logger } from "@/lib/log";
import { dueUnblockNotifications, markUnblockNotified } from "@/services/blockers/queries";
import { dueForReminder, markNotified } from "@/services/dependencies/queries";
import { localDate } from "@/services/intake";
import { useSettings } from "./hooks";
import { sendOsNotification } from "./notify";
import { run } from "./runtime";

const CHECK_EVERY_MS = 10 * 60 * 1000;

async function notifyDue() {
  const today = localDate();
  const due = await run(dueForReminder(today));
  if (due.length === 0) return;
  const first = due[0];
  const sent = await sendOsNotification(
    due.length === 1 ? "Time to follow up" : `${due.length} follow-ups due`,
    due.length === 1 && first
      ? `${first.issueKey}: ${first.label}`
      : due
          .slice(0, 3)
          .map((d) => `${d.issueKey}: ${d.label}`)
          .join("\n"),
  );
  if (!sent) return;
  await run(
    markNotified(
      due.map((d) => d.id),
      today,
    ),
  );
}

/** Most wake-up notifications sent in one check; the rest wait for the next. */
const MAX_UNBLOCK_NOTICES = 5;

/** One notification per woken ticket, each sent once (`unblock_notified_at`). */
async function notifyUnblocked() {
  const due = await run(dueUnblockNotifications());
  for (const t of due.slice(0, MAX_UNBLOCK_NOTICES)) {
    const sent = await sendOsNotification(`${t.key} is unblocked`, `${t.summary}\n${t.reason}`);
    if (!sent) return;
    await run(markUnblockNotified([t.key], new Date().toISOString()));
  }
}

export function useFollowupReminders() {
  const { data: settings } = useSettings();
  const enabled = settings?.dependencies.reminders ?? false;
  useEffect(() => {
    if (!enabled || !isTauri()) return;
    const tick = () => {
      void notifyDue().catch((e) => logger.warn("Follow-up reminder failed", e));
      void notifyUnblocked().catch((e) => logger.warn("Unblocked reminder failed", e));
    };
    const first = setTimeout(tick, 5000);
    const every = setInterval(tick, CHECK_EVERY_MS);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, [enabled]);
}

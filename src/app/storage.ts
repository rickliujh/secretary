/**
 * Storage (D34): daily auto cleanup when enabled (the default), a warning when
 * the database nears the limit set in Settings > Data, and cleanup on demand.
 */
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { pruneImportBackups } from "@/services/data/backups";
import {
  cleanup,
  cleanupIfDue,
  databaseSize,
  type StorageLevel,
  storageLevel,
} from "@/services/data/retention";
import { useSettings } from "./hooks";
import { queryClient, queryKeys } from "./query-client";
import { run } from "./runtime";
import { syncRunning, useSyncStatus } from "./sync";

const CHECK_DELAY_MS = 15_000;
const AUTO_DELAY_MS = 60_000;
const AUTO_RETRY_MS = 5 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** Cleanup now (the Settings button), or only when due (auto cleanup). */
export async function runCleanup(mode: "now" | "if-due" = "now") {
  const result = await run(mode === "now" ? cleanup() : cleanupIfDue());
  if (!result) return null;
  const backups = await pruneImportBackups().catch(() => 0);
  void queryClient.invalidateQueries({ queryKey: queryKeys.storage });
  return { ...result, backups };
}

/** A minute after launch, then daily; skipped when a cleanup ran in the last 20 hours. */
export function useAutoCleanup() {
  const { data: settings } = useSettings();
  const enabled = settings?.storage.autoCleanup ?? false;
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      // A sync holds the database; try again a little later.
      if (syncRunning()) {
        timer = setTimeout(tick, AUTO_RETRY_MS);
        return;
      }
      void runCleanup("if-due").catch(() => undefined);
      timer = setTimeout(tick, DAY_MS);
    };
    timer = setTimeout(tick, AUTO_DELAY_MS);
    return () => clearTimeout(timer);
  }, [enabled]);
}

/** Checks the size after launch and after each sync; warns once per level per session. */
export function useStorageWarning() {
  const navigate = useNavigate();
  const { data: settings } = useSettings();
  const limitMb = settings?.storage.limitMb;
  const running = useSyncStatus()?.running ?? false;
  const warned = useRef<StorageLevel>("ok");

  useEffect(() => {
    if (!limitMb || running) return;
    const check = async () => {
      const { bytes } = await run(databaseSize);
      const level = storageLevel(bytes, limitMb);
      if (level === "ok" || level === warned.current || warned.current === "over") return;
      warned.current = level;
      const used = `${Math.round(bytes / 1024 / 1024)} MB of ${limitMb} MB`;
      toast.warning(level === "over" ? "Storage limit reached" : "Storage almost full", {
        description: `The database uses ${used}. Clean up in Settings > Data, or raise the limit.`,
        duration: 15_000,
        action: {
          label: "Review",
          onClick: () => void navigate({ to: "/settings", search: { tab: "data" } }),
        },
      });
    };
    const timer = setTimeout(() => void check().catch(() => undefined), CHECK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [limitMb, running, navigate]);
}

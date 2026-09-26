/**
 * Storage limit (D34): the app warns when the database nears the limit set in
 * Settings > Data; cleanup runs only when the user asks for it.
 */
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { pruneImportBackups } from "@/services/data/backups";
import { cleanup, databaseSize, type StorageLevel, storageLevel } from "@/services/data/retention";
import { useSettings } from "./hooks";
import { queryClient, queryKeys } from "./query-client";
import { run } from "./runtime";
import { useSyncStatus } from "./sync";

const CHECK_DELAY_MS = 15_000;

export async function runCleanup() {
  const result = await run(cleanup());
  const backups = await pruneImportBackups().catch(() => 0);
  void queryClient.invalidateQueries({ queryKey: queryKeys.storage });
  return { ...result, backups };
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

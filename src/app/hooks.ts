import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Effect } from "effect";
import { useCallback } from "react";
import { type AppSettings, Settings } from "@/services/settings";
import { hasSecret } from "@/services/settings/providers";
import { toastError } from "./errors";
import { queryKeys } from "./query-client";
import { run } from "./runtime";
import type { SettingsTab } from "./settings-tabs";

export function useOpenSettings() {
  const navigate = useNavigate();
  return useCallback(
    (tab: SettingsTab) => void navigate({ to: "/settings", search: { tab } }),
    [navigate],
  );
}

/** Toasts an error with a settings link when relevant. */
export function useErrorToast() {
  const openSettings = useOpenSettings();
  return useCallback(
    (error: unknown, retry?: () => void) => toastError(error, { retry, openSettings }),
    [openSettings],
  );
}

export function useSettings() {
  return useQuery({
    queryKey: queryKeys.settings,
    queryFn: ({ signal }) =>
      run(
        Effect.flatMap(Settings, (s) => s.get),
        signal,
      ),
  });
}

export function useUpdateSettings() {
  const client = useQueryClient();
  const onError = useErrorToast();
  return useMutation({
    mutationFn: (f: (s: AppSettings) => AppSettings) =>
      run(Effect.flatMap(Settings, (s) => s.update(f))),
    onSuccess: (next) => client.setQueryData(queryKeys.settings, next),
    onError: (e) => onError(e),
  });
}

export function useSecretStatus(name: string) {
  return useQuery({
    queryKey: queryKeys.secretStatus(name),
    queryFn: ({ signal }) => run(hasSecret(name), signal),
  });
}

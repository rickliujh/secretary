import { type QueryKey, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Effect } from "effect";
import { useCallback } from "react";
import { toast } from "sonner";
import { type AppSettings, Settings } from "@/services/settings";
import { hasSecret } from "@/services/settings/providers";
import { toastError } from "./errors";
import { queryKeys } from "./query-client";
import { type AppServices, run } from "./runtime";
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

export type AppMutationOptions<I, A> = {
  /** Query keys (prefixes) to refresh after the write succeeds. */
  invalidate?: readonly QueryKey[];
  /** Also refresh after a failure, for writes that can partly apply. */
  invalidateOnError?: boolean;
  /** A success toast, fixed or built from the result. */
  success?: string | ((a: A, input: I) => string);
  /** Runs after the refresh and toast, for anything else (closing a dialog). */
  onSuccess?: (a: A, input: I) => void;
  /** Set false when the caller shows the error itself. */
  toastError?: boolean;
};

/**
 * Runs an Effect program as a mutation: refreshes the given queries, toasts
 * success, and maps failures to an error toast.
 */
export function useAppMutation<I = void, A = unknown, E = unknown>(
  program: (input: I) => Effect.Effect<A, E, AppServices>,
  opts: AppMutationOptions<I, A> = {},
) {
  const client = useQueryClient();
  const onError = useErrorToast();
  const { invalidate = [], invalidateOnError = false, success, toastError = true } = opts;
  const refresh = () => {
    for (const key of invalidate) void client.invalidateQueries({ queryKey: key });
  };
  return useMutation({
    mutationFn: (input: I) => run(program(input)),
    onSuccess: (a, input) => {
      refresh();
      if (success) toast.success(typeof success === "string" ? success : success(a, input));
      opts.onSuccess?.(a, input);
    },
    onError: (e) => {
      if (invalidateOnError) refresh();
      if (toastError) onError(e);
    },
  });
}

export function useUpdateSettings() {
  const client = useQueryClient();
  return useAppMutation(
    (f: (s: AppSettings) => AppSettings) => Effect.flatMap(Settings, (s) => s.update(f)),
    { onSuccess: (next) => client.setQueryData(queryKeys.settings, next) },
  );
}

export function useSecretStatus(name: string) {
  return useQuery({
    queryKey: queryKeys.secretStatus(name),
    queryFn: ({ signal }) => run(hasSecret(name), signal),
  });
}

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Effect } from "effect";
import { toast } from "sonner";
import { useErrorToast } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { type AppServices, run } from "@/app/runtime";

/** A local directory write that refreshes every directory query when it succeeds. */
export function useDirectoryMutation<I, A, E>(
  program: (input: I) => Effect.Effect<A, E, AppServices>,
  success?: string | ((a: A, input: I) => string),
) {
  const client = useQueryClient();
  const onError = useErrorToast();
  return useMutation({
    mutationFn: (input: I) => run(program(input)),
    onSuccess: (a, input) => {
      void client.invalidateQueries({ queryKey: queryKeys.directory });
      // Contacts link from tickets, so ticket views refresh too.
      void client.invalidateQueries({ queryKey: queryKeys.tickets });
      if (success) toast.success(typeof success === "string" ? success : success(a, input));
    },
    onError: (e) => onError(e),
  });
}

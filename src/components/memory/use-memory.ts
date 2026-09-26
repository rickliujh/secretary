import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Effect } from "effect";
import { toast } from "sonner";
import { useErrorToast } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { type AppServices, run } from "@/app/runtime";

/** A memory change that refreshes the Memory page. */
export function useMemoryMutation<I, A, E>(
  program: (input: I) => Effect.Effect<A, E, AppServices>,
  success?: string,
) {
  const client = useQueryClient();
  const onError = useErrorToast();
  return useMutation({
    mutationFn: (input: I) => run(program(input)),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.memories });
      void client.invalidateQueries({ queryKey: queryKeys.inbox });
      if (success) toast.success(success);
    },
    onError: (e) => onError(e),
  });
}

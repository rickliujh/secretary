import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Effect } from "effect";
import { toast } from "sonner";
import { useErrorToast } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { type AppServices, run } from "@/app/runtime";

/** A dependency write; refreshes dependency, ticket and inbox views. */
export function useDependencyMutation<I, A, E>(
  program: (input: I) => Effect.Effect<A, E, AppServices>,
  success?: string | ((a: A, input: I) => string),
) {
  const client = useQueryClient();
  const onError = useErrorToast();
  return useMutation({
    mutationFn: (input: I) => run(program(input)),
    onSuccess: (a, input) => {
      for (const key of [queryKeys.dependencies, queryKeys.tickets, queryKeys.inbox])
        void client.invalidateQueries({ queryKey: key });
      if (success) toast.success(typeof success === "string" ? success : success(a, input));
    },
    onError: (e) => onError(e),
  });
}

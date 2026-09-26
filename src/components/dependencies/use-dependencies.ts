import type { Effect } from "effect";
import { useAppMutation } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import type { AppServices } from "@/app/runtime";

/** A dependency write; refreshes dependency, ticket and inbox views. */
export function useDependencyMutation<I, A, E>(
  program: (input: I) => Effect.Effect<A, E, AppServices>,
  success?: string | ((a: A, input: I) => string),
) {
  return useAppMutation(program, {
    invalidate: [queryKeys.dependencies, queryKeys.tickets, queryKeys.inbox],
    success,
  });
}

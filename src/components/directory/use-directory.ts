import type { Effect } from "effect";
import { useAppMutation } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import type { AppServices } from "@/app/runtime";

/** A local directory write that refreshes every directory query when it succeeds. */
export function useDirectoryMutation<I, A, E>(
  program: (input: I) => Effect.Effect<A, E, AppServices>,
  success?: string | ((a: A, input: I) => string),
) {
  // Contacts link from tickets, so ticket views refresh too.
  return useAppMutation(program, {
    invalidate: [queryKeys.directory, queryKeys.tickets],
    success,
  });
}

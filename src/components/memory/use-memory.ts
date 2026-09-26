import type { Effect } from "effect";
import { useAppMutation } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import type { AppServices } from "@/app/runtime";

/** A memory change that refreshes the Memory page. */
export function useMemoryMutation<I, A, E>(
  program: (input: I) => Effect.Effect<A, E, AppServices>,
  success?: string,
) {
  return useAppMutation(program, { invalidate: [queryKeys.memories, queryKeys.inbox], success });
}

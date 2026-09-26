import { Effect } from "effect";
import { toast } from "sonner";
import { useAppMutation } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { Llm, type TestResult, type TestTarget } from "@/services/llm";

/**
 * A "Test" button: one short model call, toasted with who answered and how
 * fast. The call is recorded either way, so usage refreshes after a failure too.
 */
export function useLlmTest<I = void>(
  target: (input: I) => TestTarget,
  who: (r: TestResult, input: I) => string,
) {
  return useAppMutation((input: I) => Effect.flatMap(Llm, (llm) => llm.test(target(input))), {
    invalidate: [queryKeys.usage, queryKeys.recentCalls],
    invalidateOnError: true,
    onSuccess: (r, input) =>
      toast.success(`${who(r, input)} answered in ${r.durationMs} ms`, {
        description: `"${r.text.trim().slice(0, 80)}"`,
      }),
  });
}

import { Effect } from "effect";
import { toast } from "sonner";
import { useAppMutation } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { describeAction, Executor, type JiraAction } from "@/services/executor";

/** Runs a user-initiated Jira write through the Executor (the only write path). */
export function useExecute() {
  return useAppMutation((action: JiraAction) => Effect.flatMap(Executor, (e) => e.run(action)), {
    invalidate: [queryKeys.tickets],
    onSuccess: (result, action) =>
      toast.success(describeAction(action), {
        description: result.refreshed
          ? undefined
          : "Saved in Jira; the local copy refreshes on the next sync.",
      }),
  });
}

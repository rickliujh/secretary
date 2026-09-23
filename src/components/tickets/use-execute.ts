import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { toast } from "sonner";
import { useErrorToast } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { describeAction, Executor, type JiraAction } from "@/services/executor";

/** Runs a user-initiated Jira write through the Executor (the only write path). */
export function useExecute() {
  const client = useQueryClient();
  const onError = useErrorToast();
  return useMutation({
    mutationFn: (action: JiraAction) => run(Effect.flatMap(Executor, (e) => e.run(action))),
    onSuccess: (result, action) => {
      toast.success(describeAction(action), {
        description: result.refreshed
          ? undefined
          : "Saved in Jira; the local copy refreshes on the next sync.",
      });
      void client.invalidateQueries({ queryKey: queryKeys.tickets });
    },
    onError: (e) => onError(e),
  });
}

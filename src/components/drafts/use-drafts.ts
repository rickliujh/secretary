import { useNavigate } from "@tanstack/react-router";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Effect } from "effect";
import { type AppMutationOptions, useAppMutation } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import type { AppServices } from "@/app/runtime";
import { Comms, type DraftEdit, type DraftRequest } from "@/services/comms";
import {
  createDraft,
  deleteDraft,
  markCopied,
  markSent,
  saveDraft,
} from "@/services/comms/queries";
import { requestChaseDraft } from "@/services/dependencies/queries";

/**
 * A draft mutation. Sending logs a follow-up on the dependency, which also
 * moves tickets on the dashboard, so those refresh too.
 */
function useDraftMutation<I, A, E>(
  program: (input: I) => Effect.Effect<A, E, AppServices>,
  opts: Omit<AppMutationOptions<I, A>, "invalidate"> = {},
) {
  return useAppMutation(program, {
    ...opts,
    invalidate: [queryKeys.drafts, queryKeys.dependencies, queryKeys.tickets],
  });
}

export function useDraftActions(id: string) {
  const generate = useDraftMutation((instruction: string | null) =>
    Effect.flatMap(Comms, (c) => c.generate(id, { instruction })),
  );
  const save = useDraftMutation((edit: DraftEdit) => saveDraft(id, edit));
  const copy = useDraftMutation(
    (text: string) =>
      Effect.tryPromise(() => writeText(text)).pipe(Effect.zipRight(markCopied(id))),
    { success: "Copied. Paste it into Teams or your mail client." },
  );
  const sent = useDraftMutation(() => markSent(id), { success: "Marked as sent" });
  const remove = useDraftMutation(() => deleteDraft(id), { success: "Draft deleted" });
  return { generate, save, copy, sent, remove };
}

/** Creates a draft from the composer and opens it, writing it straight away. */
export function useCreateDraft() {
  const navigate = useNavigate();
  return useDraftMutation((req: DraftRequest) =>
    createDraft(req).pipe(
      Effect.tap((id) =>
        Effect.sync(() => navigate({ to: "/drafts", search: { id, write: true } })),
      ),
    ),
  );
}

/** "Draft a chase" on the Waiting page and dependency cards (Phase 6 task 3). */
export function useChaseDraft() {
  const navigate = useNavigate();
  return useDraftMutation((dependencyId: string) =>
    requestChaseDraft(dependencyId).pipe(
      Effect.tap((id) =>
        Effect.sync(() => navigate({ to: "/drafts", search: { id, write: true } })),
      ),
    ),
  );
}

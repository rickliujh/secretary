import { useNavigate } from "@tanstack/react-router";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Effect } from "effect";
import { type AppMutationOptions, useAppMutation } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import type { AppServices } from "@/app/runtime";
import { type HandoffChannel, handoffLink } from "@/lib/handoff";
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

type Handoff = { channel: HandoffChannel; to: string[]; subject: string | null; body: string };

const handoffMessage = (bodyIncluded: boolean, h: Handoff) =>
  bodyIncluded
    ? `Opened in ${h.channel === "teams" ? "Teams" : "your mail app"}. Press Send there, then mark it sent here.`
    : `The message is too long for a link; it is on your clipboard. Paste it into ${
        h.channel === "teams" ? "Teams" : "the new email"
      }, press Send, then mark it sent here.`;

export function useDraftActions(id: string) {
  // The editor shows a failed write inline with its issues, so no toast as well.
  const generate = useDraftMutation(
    (instruction: string | null) => Effect.flatMap(Comms, (c) => c.generate(id, { instruction })),
    { toastError: false },
  );
  const save = useDraftMutation((edit: DraftEdit) => saveDraft(id, edit));
  const copy = useDraftMutation(
    (text: string) =>
      Effect.tryPromise(() => writeText(text)).pipe(Effect.zipRight(markCopied(id))),
    { success: "Copied. Paste it into Teams or your mail client." },
  );
  // D31: open the user's own Teams or mail app with the text; they press Send there.
  const handoff = useDraftMutation(
    (h: Handoff) => {
      const link = handoffLink(h.channel, h);
      return Effect.gen(function* () {
        // Too long for a link: the text goes on the clipboard and the window opens empty.
        if (!link.bodyIncluded) yield* Effect.tryPromise(() => writeText(h.body));
        yield* Effect.tryPromise(() => openUrl(link.url));
        yield* markCopied(id);
        return link.bodyIncluded;
      });
    },
    { success: handoffMessage },
  );
  const sent = useDraftMutation(() => markSent(id), { success: "Marked as sent" });
  const remove = useDraftMutation(() => deleteDraft(id), { success: "Draft deleted" });
  return { generate, save, copy, handoff, sent, remove };
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

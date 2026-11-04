import { type Mutation, useMutationState, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { useEffect, useRef, useState } from "react";
import { useAppMutation } from "@/app/hooks";
import { runStore, useNow, useRunFor, useRuns } from "@/app/intake-runs";
import { queryKeys } from "@/app/query-client";
import { type AppServices, run } from "@/app/runtime";
import { requestWorkPass } from "@/app/work";
import type { ReplyInput, Source, TriageInput, TurnControl } from "@/services/intake";
import { isActive, isRunning, type RunRequest, viewOf } from "@/services/intake/runs";
import { hasInput, type MessagePart } from "@/services/intake/thread";
import { type ProposalPayload, Proposals } from "@/services/proposals";

/**
 * Everything a decision can change: the thread, tickets, contacts, and what
 * approved proposals create (dependencies, drafts, memories). Edits and
 * rejections are also kept as corrections on the Memory page.
 */
const DECISION_KEYS = [
  queryKeys.inbox,
  queryKeys.tickets,
  queryKeys.directory,
  queryKeys.dependencies,
  queryKeys.drafts,
  queryKeys.memories,
  // The note's marks and cards (D67) say what its threads hold.
  queryKeys.note,
];

/** What a saved edit changes: the thread and the sprint fits that count its creates. */
const SAVE_EDIT_KEYS = [queryKeys.inbox, ["tickets", "sprint-fit"]] as const;

export function useInvalidateAfterDecision() {
  const client = useQueryClient();
  return () => {
    for (const key of DECISION_KEYS) void client.invalidateQueries({ queryKey: key });
    // A triage or a reply is news for the work model (D61).
    requestWorkPass();
  };
}

/** Names saves of a pending proposal's edits (D44 rows, D57 sprint switch). */
export const SAVE_EDIT_MUTATION = ["save-edit"] as const;

export type SaveEditInput = { id: string; edited: ProposalPayload; inboxItemId?: string | null };

const saveOf = (m: Pick<Mutation, "state">) => (m.state.variables ?? null) as SaveEditInput | null;

/**
 * Saves of pending proposals' edits still being written, by proposal id. Saves
 * of one proposal run in order, and an approve (or Approve all, or Track)
 * waits for them, so it always reads the newest choice without the buttons
 * being disabled while a save runs (D57).
 */
const writes = new Map<string, { inboxItemId: string | null; done: Promise<unknown> }>();

const writeEdit = (i: SaveEditInput) =>
  Effect.tryPromise({
    try: () => {
      const before = writes.get(i.id)?.done.catch(() => undefined) ?? Promise.resolve();
      const done = before.then(() =>
        run(Effect.flatMap(Proposals, (p) => p.saveEdit(i.id, i.edited))),
      );
      const entry = { inboxItemId: i.inboxItemId ?? null, done };
      writes.set(i.id, entry);
      void done
        .catch(() => undefined)
        .finally(() => {
          if (writes.get(i.id) === entry) writes.delete(i.id);
        });
      return done;
    },
    catch: (e) => e,
  });

/** Waits for the edits being written to these proposals, or to any in a thread. */
const afterWrites = (filter: { ids?: readonly string[]; inboxItemId?: string }) =>
  Effect.promise(() =>
    Promise.all(
      [...writes.entries()]
        .filter(([id, w]) =>
          filter.ids ? filter.ids.includes(id) : w.inboxItemId === filter.inboxItemId,
        )
        .map(([, w]) => w.done.catch(() => undefined)),
    ),
  );

/** The newest edit of this proposal still being saved, from any component; null when none. */
export function usePendingEdit(id: string): ProposalPayload | null {
  const pending = useMutationState({
    filters: {
      mutationKey: SAVE_EDIT_MUTATION,
      status: "pending",
      predicate: (m) => saveOf(m)?.id === id,
    },
    select: (m) => saveOf(m)?.edited ?? null,
  });
  return pending.at(-1) ?? null;
}

/** An intake turn is reading or revising this thread (D68: the run store's). */
export function useTurnRunning(inboxItemId: string | null) {
  const run = useRunFor(inboxItemId);
  return !!run && isRunning(run);
}

/**
 * Sends one intake turn to the run store (D68): it starts now or waits behind
 * the run going; the composer never waits. `isPending` while a turn this hook
 * sent is queued or running; `progress` is its one line; `cancel` stops it.
 */
function useIntakeTurn<I>(
  request: (input: I) => RunRequest,
  lane: (input: I) => string,
  onStored?: (inboxItemId: string) => void,
) {
  const [ids, setIds] = useState<readonly string[]>([]);
  const runs = useRuns();
  const mine = runs.filter((r) => ids.includes(r.id));
  const active = mine.filter(isActive);
  const current = active.find(isRunning) ?? active[0] ?? null;
  const now = useNow(!!current);
  // A new thread opens as soon as its message is stored (FR-21.1).
  const told = useRef(new Set<string>());
  const stored = useRef(onStored);
  stored.current = onStored;
  useEffect(() => {
    for (const r of mine)
      if (r.inboxItemId && r.request.kind === "triage" && !told.current.has(r.id)) {
        told.current.add(r.id);
        stored.current?.(r.inboxItemId);
      }
  });
  return {
    mutate: (input: I) => {
      const id = runStore.startRun(request(input), { lane: lane(input) });
      setIds((x) => [...x, id]);
      return id;
    },
    isPending: active.length > 0,
    progress: current ? viewOf(current, now).line : null,
    cancel: () => {
      if (current) runStore.stop(current.id);
    },
  };
}

/** Starts a thread (D22); `onStored` gets its id as soon as the message is in it. */
export function useTriage(onStored?: (inboxItemId: string) => void) {
  return useIntakeTurn(
    (input: Omit<TriageInput, keyof TurnControl>): RunRequest => ({ kind: "triage", input }),
    () => "new",
    onStored,
  );
}

/** Replies in a thread: new input, an instruction or an answer (D22). */
export function useReply() {
  return useIntakeTurn(
    (input: Omit<ReplyInput, keyof TurnControl>): RunRequest => ({ kind: "reply", input }),
    (input) => input.inboxItemId,
  );
}

/**
 * Replying in one thread as its view does (D22, D61): a typed reply answers
 * the newest open question unless the user opted out (`skip`); pasted input
 * starts new items instead; a choice answers its own question. The Inbox's
 * thread and the note's cards (D67) share it. `reply.isPending` while a turn of
 * this thread is queued or running, wherever it was sent from (D68).
 */
export function useThreadReply<P extends { id: string; kind: string; status: string }>(
  inboxItemId: string,
  proposals: readonly P[] | undefined,
) {
  const sender = useReply();
  const runs = useRuns();
  const busy = runs.some((r) => isActive(r) && r.inboxItemId === inboxItemId);
  const reply = { ...sender, isPending: busy };
  const [skipped, skip] = useState<string | null>(null);
  const open = (proposals ?? [])
    .filter((p) => p.kind === "needs_clarification" && p.status === "pending")
    .at(-1);
  const answering = open && open.id !== skipped ? open : null;
  const send = (m: { parts: MessagePart[]; source?: Source }) => {
    const withInput = hasInput(m.parts, true);
    sender.mutate({
      inboxItemId,
      parts: m.parts,
      source: withInput ? m.source : undefined,
      answers: answering && !withInput ? answering.id : null,
    });
  };
  /** A one-click answer: the choice, typed, as the reply to that question (D61). */
  const choose = (proposalId: string, choice: string) =>
    sender.mutate({ inboxItemId, parts: [{ type: "typed", text: choice }], answers: proposalId });
  return { reply, answering, skip, send, choose };
}

/**
 * Re-triage through the run store (D68): a turn that stopped or failed part way
 * reads the items it left; otherwise the thread is read again.
 */
function useRetriage(thread?: string) {
  const runs = useRuns();
  return {
    mutate: (inboxItemId: string) =>
      runStore.startRun({ kind: "retriage", inboxItemId }, { lane: inboxItemId }),
    isPending: runs.some(
      (r) =>
        isActive(r) &&
        r.inboxItemId === thread &&
        (r.request.kind === "retriage" || r.request.kind === "resume"),
    ),
  };
}

/** A decision can partly apply before it fails, so views refresh either way. */
function useDecisionMutation<A, E, I>(
  program: (input: I) => Effect.Effect<A, E, AppServices>,
  mutationKey?: readonly unknown[],
  opts: { awaitRefresh?: boolean } = {},
) {
  // Every decision is news for the work model (D61), whether it ran or failed.
  return useAppMutation(
    (input: I) => Effect.ensuring(program(input), Effect.sync(requestWorkPass)),
    {
      invalidate: DECISION_KEYS,
      invalidateOnError: true,
      ...(mutationKey ? { mutationKey } : {}),
      ...opts,
    },
  );
}

/** Names revoke mutations, so every Revoke of a thread can wait while one runs. */
export const REVOKE_MUTATION = ["revoke"] as const;
/** What a running revoke carries: the proposal and its thread. */
export type RevokeInput = {
  id: string;
  inboxItemId: string | null;
  confirmed: readonly string[];
};

const withProposals =
  <A, E, I>(f: (p: Proposals["Type"], input: I) => Effect.Effect<A, E>) =>
  (input: I) =>
    Effect.flatMap(Proposals, (p) => f(p, input));

/** `inboxItemId`: the thread whose Re-triage `retriage.isPending` follows. */
export function useDecisions(inboxItemId?: string) {
  const approve = useDecisionMutation(
    withProposals((p, i: { id: string; edited?: ProposalPayload }) =>
      Effect.zipRight(afterWrites({ ids: [i.id] }), p.approve(i.id, i.edited)),
    ),
  );
  const reject = useDecisionMutation(withProposals((p, id: string) => p.reject(id)));
  const approveAll = useDecisionMutation(
    withProposals((p, inboxItemId: string) =>
      Effect.zipRight(afterWrites({ inboxItemId }), p.approveAll(inboxItemId)),
    ),
  );
  const dismiss = useDecisionMutation(
    withProposals((p, inboxItemId: string) => p.dismiss(inboxItemId)),
  );
  /** Track (D44): the small-ask create and what hangs on it, in order. */
  const track = useDecisionMutation(
    withProposals(
      (p, i: { ids: readonly string[]; edits?: Readonly<Record<string, ProposalPayload>> }) =>
        Effect.zipRight(afterWrites({ ids: i.ids }), p.track(i.ids, i.edits)),
    ),
  );
  /**
   * An outcome card (Phase 25) or a playbook bundle in a thread (Phase 26): the
   * steps the user kept, in order, after their saved edits; `found` is the
   * ticket picked among those the search found (null: none of them).
   */
  const approveBundle = useDecisionMutation(
    withProposals((p, i: { bundleId: string; keep: readonly string[]; found?: string | null }) =>
      Effect.zipRight(
        afterWrites({ ids: i.keep }),
        p.approveBundle(i.bundleId, i.keep, {}, i.found === undefined ? {} : { found: i.found }),
      ),
    ),
  );
  /** "Done anyway": files an outcome card a failed step keeps open (Phase 25). */
  const fileBundle = useDecisionMutation(
    withProposals((p, bundleId: string) => p.fileBundle(bundleId)),
  );
  /**
   * Keeps a row change or the sprint switch on a pending proposal, so any
   * approve uses it (D44, D57). It changes only that proposal, so only the
   * Inbox and the sprint fits are read again, and it stays pending until they
   * are back, so a switch shows the new value throughout (`usePendingEdit`).
   */
  const saveEdit = useAppMutation(writeEdit, {
    invalidate: SAVE_EDIT_KEYS,
    invalidateOnError: true,
    mutationKey: SAVE_EDIT_MUTATION,
    awaitRefresh: true,
  });
  /** Revoke (FR-14): the steps the user confirmed; a failed step comes back as a result. */
  const revoke = useDecisionMutation(
    withProposals((p, i: RevokeInput) => p.revoke(i.id, i.confirmed)),
    REVOKE_MUTATION,
  );
  const retriage = useRetriage(inboxItemId);
  return {
    approve,
    reject,
    approveAll,
    track,
    approveBundle,
    fileBundle,
    saveEdit,
    dismiss,
    retriage,
    revoke,
  };
}

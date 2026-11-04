/**
 * The Inbox's runs live here, outside React, for as long as the app runs (FR-21,
 * D68), like the chats (D28): leaving the thread and coming back finds the run
 * going, its card, its list row and the navigation entry all read this store.
 */
import { Effect } from "effect";
import { useEffect, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { z } from "zod";
import { requestWorkPass } from "@/app/work";
import { Intake, type TriageResult } from "@/services/intake";
import {
  createRunStore,
  isActive,
  QUEUE_KEY,
  type QueuedMessage,
  type Run,
  type RunControl,
} from "@/services/intake/runs";
import { MessagePartSchema } from "@/services/intake/thread";
import { getState, setState } from "@/services/sync/state";
import { describeError, isInterrupted, toastError } from "./errors";
import { queryClient, queryKeys } from "./query-client";
import { run as runEffect } from "./runtime";

/** What a turn can change: the thread and what approved cards make, as a decision does. */
const TURN_KEYS = [
  queryKeys.inbox,
  queryKeys.tickets,
  queryKeys.directory,
  queryKeys.dependencies,
  queryKeys.drafts,
  queryKeys.memories,
  queryKeys.note,
];

const refreshThreads = () => {
  void queryClient.invalidateQueries({ queryKey: queryKeys.inbox });
  // The note's cards (D67) show its threads' cards too.
  void queryClient.invalidateQueries({ queryKey: queryKeys.note });
};

const summarise = (r: TriageResult) =>
  r.proposals || r.questions
    ? `${r.proposals} proposal${r.proposals === 1 ? "" : "s"}${r.questions ? ` and ${r.questions} question${r.questions === 1 ? "" : "s"}` : ""} to review`
    : "Nothing to do in that input";

const execute = (r: Run, c: RunControl) => {
  const control = { onEvent: c.onEvent, skip: c.skip };
  const req = r.request;
  return runEffect(
    Effect.flatMap(Intake, (intake) => {
      switch (req.kind) {
        case "triage":
          return intake.triage({ ...req.input, ...control });
        case "reply":
          return intake.reply({ ...req.input, ...control });
        case "resume":
          return intake.resume(req.inboxItemId, {
            ...control,
            ...(req.tier ? { tier: req.tier } : {}),
            ...(req.messageId !== undefined ? { messageId: req.messageId } : {}),
          });
        case "retriage":
          return intake.retriage(req.inboxItemId, control);
      }
    }),
    c.signal,
  );
};

export const runStore = createRunStore({
  execute,
  withdraw: (messageId) =>
    runEffect(Effect.flatMap(Intake, (i) => i.withdraw(messageId))).finally(refreshThreads),
  isStop: isInterrupted,
  describe: (e) => {
    const d = describeError(e);
    const kind = (e as { kind?: unknown } | null)?.kind;
    return {
      message: d.description ? `${d.title}: ${d.description}` : d.title,
      kind: typeof kind === "string" ? kind : null,
    };
  },
  onChange: (_run, e) => {
    // The message lands in its thread at once; each item's cards as they are written.
    // The lookups start once the turn's record is written: the cards it revises lock.
    if (
      e?.type === "stored" ||
      e?.type === "item_done" ||
      (e?.type === "step" && e.name === "lookup" && e.phase === "start")
    )
      refreshThreads();
  },
  onEnd: (r) => {
    for (const key of TURN_KEYS) void queryClient.invalidateQueries({ queryKey: key });
    // A turn is news for the work model (D61).
    requestWorkPass();
    if (r.state === "done" && r.result) toast.success(summarise(r.result));
  },
  onWithdrawError: (_run, e) => toastError(e),
  // Queued messages are kept across a restart, and come back as drafts (D68).
  onQueue: (queued) => {
    void runEffect(setState(QUEUE_KEY, JSON.stringify(queued))).catch(() => undefined);
  },
});

const QueueSchema = z.array(z.object({ lane: z.string(), parts: z.array(MessagePartSchema) }));

let recovering: Promise<unknown> | null = null;
/**
 * Once per launch (D68): turns in flight when the app quit become stopped
 * turns, and messages that were queued come back in their boxes as drafts.
 */
export const recoverRunsOnce = () => {
  recovering ??= runEffect(
    Effect.gen(function* () {
      yield* Effect.flatMap(Intake, (i) => i.recoverRuns);
      const kept = QueueSchema.safeParse(JSON.parse((yield* getState(QUEUE_KEY)) ?? "[]"));
      const list: QueuedMessage[] = kept.success ? kept.data : [];
      if (list.length) {
        runStore.restoreQueue(list);
        yield* setState(QUEUE_KEY, "[]");
      }
    }),
  ).catch(() => undefined);
  return recovering;
};

/** Every run, re-rendering on each change. */
export function useRuns(): readonly Run[] {
  return useSyncExternalStore(runStore.subscribe, runStore.snapshot);
}

/** The thread's newest run, if the store has one. */
export function useRunFor(inboxItemId: string | null): Run | null {
  // Subscribes; the newest run is read from the store's snapshot.
  useRuns();
  return inboxItemId ? runStore.runFor(inboxItemId) : null;
}

/** The runs waiting in a composer's lane (FR-21.1). */
export function useQueued(lane: string): readonly Run[] {
  const runs = useRuns();
  return runs.filter((r) => r.state === "queued" && r.lane === lane);
}

/** The time, ticking each second while `active`, for elapsed times and the slow notice. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** Drafts given back to the composers (Edit, corrections after a stop, a kept queue). */
export function useDrafts(): number {
  return useSyncExternalStore(runStore.subscribe, runStore.draftsVersion);
}

/** Runs going or waiting, for the navigation entry. */
export function useActiveRuns(): readonly Run[] {
  return useRuns().filter(isActive);
}

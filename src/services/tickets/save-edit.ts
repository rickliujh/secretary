/**
 * One Save of the ticket view's Edit dialog (FR-17.2, D58): the changed writes
 * run in order through the Executor, the only write path, and stop at the first
 * failure, so the dialog can say what was saved and what was not.
 */
import { Effect } from "effect";
import { Executor } from "@/services/executor";
import type { EditOutcome, EditStep } from "./edit";

export const saveTicketEdit = (steps: readonly EditStep[]) =>
  Effect.gen(function* () {
    const executor = yield* Executor;
    const saved: EditStep[] = [];
    let refreshed = true;
    for (const [i, step] of steps.entries()) {
      const r = yield* Effect.either(executor.run(step.action));
      if (r._tag === "Left")
        return {
          saved,
          failed: { step, error: r.left },
          skipped: steps.slice(i + 1),
          refreshed,
        } satisfies EditOutcome;
      saved.push(step);
      refreshed &&= r.right.refreshed;
    }
    return { saved, failed: null, skipped: [], refreshed } satisfies EditOutcome;
  });

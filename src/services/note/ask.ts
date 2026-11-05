/**
 * "Ask the secretary about this" on a block of the note (FR-20.7, D67). The
 * block is taken from the stored body by its hash and routed as the reading
 * routes a new block (D66), by code: a block that already has a conversation
 * opens it; one carried over from a block of another day that had one joins
 * that thread; a changed block revises the thread of the block it replaces; a
 * block naming a ticket a recent note thread made continues that thread.
 * Otherwise it starts a thread with `Intake.triage` exactly as the reading's
 * act does. The block is recorded acted, so later edits revise that thread.
 * A block's images are read as the reading reads them (D71); when one cannot
 * be read now, Ask fails with the reason and records nothing. A private block
 * is never sent, nor its images loaded. Nothing here calls `JiraClient`.
 */
import { Effect, Either } from "effect";
import { localDate } from "@/lib/dates";
import { Intake } from "@/services/intake";
import { Settings, settingsOrDefault } from "@/services/settings";
import { NoteError } from ".";
import { splitBlocks } from "./blocks";
import { imageVault, prepareBlock, readingBudget } from "./image-reads";
import { blockRows, loadRow, recentBlocks, recentNoteThreads, recordBlock } from "./queries";
import {
  cameBackAfterDone,
  changedFrom,
  continueThread,
  namedThread,
  replaceable,
  reviseThread,
  startThread,
} from "./read";

export const askBlock = (date: string, hash: string, opts: { now?: Date } = {}) =>
  Effect.gen(function* () {
    const today = localDate(opts.now ?? new Date());
    const settings = yield* settingsOrDefault(yield* Settings);
    const intake = yield* Intake;
    const body = (yield* loadRow(date))?.body ?? "";
    const blocks = splitBlocks(body, settings.secretary.dailyNote.privateHeading);
    const block = blocks.find((b) => b.hash === hash);
    if (!block)
      return yield* new NoteError({
        kind: "not_found",
        message: "That line is no longer in the note; it may have been edited since.",
      });
    if (block.private)
      return yield* new NoteError({
        kind: "private",
        message: "That line is under your private heading, so it is never sent to a model.",
      });
    const known = yield* blockRows([date]);
    const seen = known.find((r) => r.hash === hash);
    // Already a conversation: open it.
    if (seen?.inboxItemId && (seen.status === "acted" || seen.status === "revised"))
      return { inboxItemId: seen.inboxItemId };

    // Carried over from another day where it led to a conversation (D66).
    const { byHash: recent, ticked } = yield* recentBlocks(today);
    const earlier = recent.get(hash);
    if (
      earlier &&
      earlier.date !== date &&
      earlier.status === "acted" &&
      earlier.inboxItemId &&
      !(yield* cameBackAfterDone(ticked)(earlier))
    ) {
      yield* recordBlock(date, block, "acted", { inboxItemId: earlier.inboxItemId });
      return { inboxItemId: earlier.inboxItemId };
    }

    // From here the block goes to a model: its images are read first (D71).
    const prepared = yield* prepareBlock(yield* imageVault, block.text, readingBudget(true));
    if (prepared.status === "wait")
      return yield* new NoteError({
        kind: "unavailable",
        message: `The image on that line cannot be read now: ${prepared.message}.`,
      });
    const placed = { date, block, today, modelText: prepared.text };

    // A block the reading has not seen may be an earlier one changed (D66).
    if (!seen) {
      const { gone, pendingIn } = yield* replaceable(known, new Set(blocks.map((b) => b.hash)));
      const old = changedFrom(block, gone, new Set(), pendingIn);
      if (old?.inboxItemId) {
        const r = yield* reviseThread(intake, { id: old.id, inboxItemId: old.inboxItemId }, placed);
        if (Either.isLeft(r)) return yield* Effect.fail(r.left);
        return { inboxItemId: old.inboxItemId };
      }
    }

    // Names a ticket a recent note thread made or acts on: that thread (D66).
    const named = namedThread(block.text, yield* recentNoteThreads(today));
    if (named) {
      const r = yield* continueThread(intake, named.id, placed);
      if (Either.isLeft(r)) return yield* Effect.fail(r.left);
      return { inboxItemId: named.id };
    }

    // A new conversation, as the reading's act. A failed triage that left its
    // thread opens it with the error and Try again.
    const started = yield* startThread(intake, placed, { orphan: false });
    if (started.inboxItemId) return { inboxItemId: started.inboxItemId };
    return yield* started.error
      ? Effect.fail(started.error)
      : new NoteError({
          kind: "unavailable",
          message: "The secretary could not start a conversation on that line.",
        });
  });

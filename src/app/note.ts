/**
 * The daily note in the webview (D65): one reading at a time, from the work
 * pass, the page's typing timer, Read now and the chat. Everything runs on the
 * app's own runtime while the app is open; nothing runs with it closed.
 */
import { Effect } from "effect";
import { logger } from "@/lib/log";
import { DailyNote, type ReadResult, type ReadTrigger } from "@/services/note";
import { TypingClock } from "./note-idle";
import { queryClient, queryKeys } from "./query-client";
import { run } from "./runtime";

let reading: Promise<ReadResult> | null = null;
const typing = new TypingClock();

/** The page calls this on every keystroke, so a pass does not read a line being written. */
export function noteTyped() {
  typing.typed(Date.now());
}

/** Refreshes what a reading or a sync changed. */
export function noteChanged(r?: ReadResult) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.note });
  if (!r) return;
  if (r.cards || r.revised || r.continued || r.closed)
    void queryClient.invalidateQueries({ queryKey: queryKeys.inbox });
  if (r.notes.length) void queryClient.invalidateQueries({ queryKey: queryKeys.tickets });
}

/**
 * Reads the note now; a second ask while one runs gets its result. A pass
 * reads only once typing has stopped for a minute (null otherwise: the page's
 * timer or the next pass reads it). The work pass is asked for after a
 * reading that made threads or notes (`onWork`), except by the pass itself.
 */
export function readNoteNow(trigger: ReadTrigger, onWork?: () => void): Promise<ReadResult | null> {
  if (trigger === "pass" && !typing.idle(Date.now())) return Promise.resolve(null);
  if (reading) return reading;
  const running = run(Effect.flatMap(DailyNote, (n) => n.read(trigger))).then((r) => {
    noteChanged(r);
    if (onWork && (r.cards || r.notes.length || r.revised)) onWork();
    return r;
  });
  reading = running;
  void running
    .catch((e) => logger.warn("Reading the daily note failed", e))
    .finally(() => {
      if (reading === running) reading = null;
    });
  return running;
}

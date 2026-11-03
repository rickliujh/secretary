/**
 * When the user last typed in the note (D65). The work pass reads the note
 * only once typing has stopped for a minute, so a half-written line is not
 * read; the page's own timer, a minute after the last keystroke, and Read now
 * pick it up. Pure, so the rule is tested without the app's runtime.
 */

/** Typing must have stopped this long before a pass reads the note. */
export const NOTE_IDLE_MS = 60_000;

export class TypingClock {
  private last = Number.NEGATIVE_INFINITY;

  constructor(private readonly idleMs = NOTE_IDLE_MS) {}

  /** A keystroke in the note at `now` (ms). */
  typed(now: number) {
    this.last = now;
  }

  /** Whether typing has stopped long enough at `now` for a pass to read. */
  idle(now: number): boolean {
    return now - this.last >= this.idleMs;
  }
}

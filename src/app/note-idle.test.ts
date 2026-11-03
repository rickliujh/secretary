import { describe, expect, test } from "bun:test";
import { NOTE_IDLE_MS, TypingClock } from "./note-idle";

describe("a pass reads the note only once typing stopped (D65)", () => {
  test("idle before any typing; not while typing; idle again a minute after the last keystroke", () => {
    const clock = new TypingClock();
    expect(clock.idle(0)).toBe(true);
    clock.typed(1_000);
    expect(clock.idle(1_000)).toBe(false);
    clock.typed(30_000);
    expect(clock.idle(30_000 + NOTE_IDLE_MS - 1)).toBe(false);
    expect(clock.idle(30_000 + NOTE_IDLE_MS)).toBe(true);
  });
});

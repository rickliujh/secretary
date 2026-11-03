import { describe, expect, test } from "bun:test";
import { PassScheduler, type Timers } from "./work-scheduler";

/** Timers on a clock the test moves by hand. */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; f: () => void }>();
  const timers: Timers = {
    now: () => now,
    set: (f, ms) => {
      const id = next++;
      pending.set(id, { at: now + ms, f });
      return id;
    },
    clear: (h) => pending.delete(h as number),
  };
  const advance = async (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...pending]
        .filter(([, t]) => t.at <= until)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      pending.delete(due[0]);
      now = due[1].at;
      due[1].f();
      await Promise.resolve();
      await Promise.resolve();
    }
    now = until;
  };
  return { timers, advance };
}

describe("PassScheduler", () => {
  test("requests close together make one run; the next waits a minute after it began", async () => {
    const { timers, advance } = fakeTimers();
    const runs: number[] = [];
    const s = new PassScheduler(async () => void runs.push(timers.now()), { timers });
    s.request();
    s.request();
    await advance(2000);
    expect(runs).toEqual([2000]);
    s.request();
    await advance(10_000);
    expect(runs).toEqual([2000]);
    await advance(60_000);
    expect(runs).toEqual([2000, 62_000]);
  });

  test("a request during a run is kept for after it, never two at once", async () => {
    const { timers, advance } = fakeTimers();
    let release: () => void = () => undefined;
    let active = 0;
    let most = 0;
    let count = 0;
    const s = new PassScheduler(
      () =>
        new Promise<void>((r) => {
          active++;
          count++;
          most = Math.max(most, active);
          release = () => {
            active--;
            r();
          };
        }),
      { timers },
    );
    s.request();
    await advance(2000);
    s.request();
    release();
    await advance(0);
    await advance(61_000);
    release();
    expect(most).toBe(1);
    expect(count).toBe(2);
  });
});

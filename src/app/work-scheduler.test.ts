import { describe, expect, test } from "bun:test";
import { DailyTrigger, minutesOf, PassScheduler, type Timers } from "./work-scheduler";

/** Timers on a clock the test moves by hand. */
function fakeTimers(start = 0) {
  let now = start;
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

describe("DailyTrigger (the end-of-day pass at a set time, D63)", () => {
  const MIN = 60_000;
  const at = (day: number, h: number, m: number) => new Date(2026, 9, day, h, m).getTime();

  test("fires once a day when the clock passes the time while the app is open", async () => {
    const { timers, advance } = fakeTimers(at(19, 17, 0));
    const runs: number[] = [];
    const t = new DailyTrigger(async () => void runs.push(timers.now()), { timers });
    t.start("17:30");
    await advance(29 * MIN);
    expect(runs).toEqual([]);
    await advance(2 * MIN);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toBeGreaterThanOrEqual(at(19, 17, 30));
    // Restarting the same day (a settings save) does not run it again.
    t.start("17:30");
    await advance(60 * MIN);
    expect(runs).toHaveLength(1);
    // The next day, at the same time, once more.
    await advance(at(20, 17, 31) - timers.now());
    expect(runs).toHaveLength(2);
    t.stop();
  });

  test("an app opened after the time does not run it late that day", async () => {
    const { timers, advance } = fakeTimers(at(19, 18, 0));
    let runs = 0;
    const t = new DailyTrigger(
      async () => {
        runs++;
      },
      { timers },
    );
    t.start("17:30");
    await advance(3 * 60 * MIN);
    expect(runs).toBe(0);
    await advance(at(20, 17, 31) - timers.now());
    expect(runs).toBe(1);
    t.stop();
  });

  test("stopped, it does nothing; a bad time never fires", async () => {
    const { timers, advance } = fakeTimers(at(19, 17, 0));
    let runs = 0;
    const t = new DailyTrigger(
      async () => {
        runs++;
      },
      { timers },
    );
    t.start("17:30");
    t.stop();
    await advance(60 * MIN);
    t.start("25:00");
    await advance(24 * 60 * MIN);
    expect(runs).toBe(0);
    expect(minutesOf("17:30")).toBe(1050);
    expect(minutesOf("7:30")).toBeNull();
  });
});

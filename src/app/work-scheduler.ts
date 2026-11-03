/**
 * When the work pass runs (D61): after a sync, a triage, an approval or a
 * revoke, debounced to at most one run a minute, never two at once. A request
 * while a run is going is kept and runs after it, within the same limit.
 */

export type Timers = {
  now: () => number;
  set: (f: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

const realTimers: Timers = {
  now: () => Date.now(),
  set: (f, ms) => setTimeout(f, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export class PassScheduler {
  private timer: unknown = null;
  private running = false;
  private again = false;
  private lastStart = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly run: () => Promise<unknown>,
    private readonly opts: { minGapMs?: number; settleMs?: number; timers?: Timers } = {},
  ) {}

  private get timers() {
    return this.opts.timers ?? realTimers;
  }

  /** Asks for a pass; it runs once things settle and a minute after the last one began. */
  request() {
    if (this.running) {
      this.again = true;
      return;
    }
    if (this.timer !== null) return;
    const now = this.timers.now();
    const at = Math.max(
      now + (this.opts.settleMs ?? 2000),
      this.lastStart + (this.opts.minGapMs ?? 60_000),
    );
    this.timer = this.timers.set(() => void this.fire(), at - now);
  }

  private async fire() {
    this.timer = null;
    this.running = true;
    this.lastStart = this.timers.now();
    try {
      await this.run();
    } catch {
      // A failed pass is logged by the pass; the next request tries again.
    } finally {
      this.running = false;
      if (this.again) {
        this.again = false;
        this.request();
      }
    }
  }

  /** Drops a scheduled run (the app is closing, or the work model was turned off). */
  cancel() {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    this.again = false;
  }
}

/** Minutes after midnight of a local "HH:MM" time; null when it is no time. */
export function minutesOf(at: string): number | null {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(at);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** The local day of a moment, as YYYY-MM-DD. */
const dayOf = (ms: number) => new Date(ms).toLocaleDateString("en-CA");

/** The moment of `at` on the local day of `ms`. */
const atOn = (ms: number, minutes: number) => {
  const d = new Date(ms);
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    Math.floor(minutes / 60),
    minutes % 60,
  ).getTime();
};

/**
 * The end-of-day pass at a set time (D63): while the app is open, once per
 * local day, when the clock passes `at`. It checks every `tickMs` (30 s) and
 * fires only when the time fell between two checks, so an app opened after
 * the time does not run it late; the user can still ask from Today or the
 * chat. A run that fails is not retried that day.
 */
export class DailyTrigger {
  private timer: unknown = null;
  private lastCheck = 0;
  private firedOn: string | null = null;
  private minutes: number | null = null;

  constructor(
    private readonly run: () => Promise<unknown>,
    private readonly opts: { tickMs?: number; timers?: Timers } = {},
  ) {}

  private get timers() {
    return this.opts.timers ?? realTimers;
  }

  /** Starts (or moves) the trigger to `at`, counting from now. */
  start(at: string) {
    this.stop();
    this.minutes = minutesOf(at);
    if (this.minutes === null) return;
    this.lastCheck = this.timers.now();
    this.schedule();
  }

  stop() {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }

  private schedule() {
    this.timer = this.timers.set(() => this.tick(), this.opts.tickMs ?? 30_000);
  }

  private tick() {
    this.timer = null;
    const now = this.timers.now();
    const minutes = this.minutes;
    if (minutes !== null) {
      const due = atOn(now, minutes);
      const today = dayOf(now);
      if (this.lastCheck < due && due <= now && this.firedOn !== today) {
        this.firedOn = today;
        void this.run().catch(() => undefined);
      }
    }
    this.lastCheck = now;
    this.schedule();
  }
}

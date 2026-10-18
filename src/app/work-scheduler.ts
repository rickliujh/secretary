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

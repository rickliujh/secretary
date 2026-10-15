import { describe, expect, test } from "bun:test";
import { DEFAULT_WEIGHTS } from "@/services/settings/schema";
import { ask, mixedInputs, NOW, TODAY } from "@/test/today-fixture";
import {
  beginAction,
  canAct,
  changeMode,
  releaseAction,
  SWEEP_SETTLE_MS,
  type SweepSession,
  settleAction,
  shownId,
  skipShown,
  stalePassDue,
  startSweep,
  submitsReason,
  sweepItems,
  sweepKey,
  sweepOutcomes,
  sweepSummary,
} from "./sweep";
import { buildToday } from "./today";

const issues = mixedInputs().issues.map((i) =>
  i.key === "ASK-1"
    ? { ...i, dueDate: "2026-10-06" }
    : i.key === "ASK-2"
      ? { ...i, updated: "2026-09-01T09:00:00.000Z" }
      : i,
);
const today = buildToday(
  mixedInputs({ issues: [...issues, ask("ASK-9", { dueDate: TODAY })] }),
  DEFAULT_WEIGHTS,
  TODAY,
  NOW,
);
const ids = (stale: boolean) => sweepItems(today, TODAY, { stale }).map((i) => [i.why, i.id]);

describe("the sweep's order (D49)", () => {
  test("woken, follow-ups due or overdue, owners back, asks due or overdue (soonest first)", () => {
    expect(ids(false)).toEqual([
      ["woken", "WOKE-1"],
      ["followup", "wait:d-over"],
      ["followup", "wait:d-follow"],
      ["back", "wait:d-back"],
      ["ask_due", "ASK-1"],
      ["ask_due", "ASK-9"],
    ]);
  });

  test("once a week, asks nobody touched for 14 days come last, each item once", () => {
    expect(ids(true).slice(-2)).toEqual([
      ["ask_due", "ASK-9"],
      ["ask_stale", "ASK-2"],
    ]);
  });

  test("sleeping waits, snoozed tickets, comments and threads are not swept", () => {
    const all = ids(true).map(([, id]) => id);
    for (const id of ["wait:d-asleep", "wait:d-snz", "ASK-5", "CMT-1", "wait:d-ask"])
      expect(all).not.toContain(id);
  });

  test("an overdue wait with its next chase set for a later day is not swept until then", () => {
    const later = (day: string) =>
      buildToday(
        mixedInputs({
          dependencies: mixedInputs().dependencies.map((d) =>
            d.id === "d-over" ? { ...d, nextFollowupAt: "2026-10-09" } : d,
          ),
        }),
        DEFAULT_WEIGHTS,
        day,
        `${day}T09:00:00.000Z`,
      );
    const swept = sweepItems(later(TODAY), TODAY, { stale: false }).map((i) => i.id);
    expect(swept).not.toContain("wait:d-over");
    expect(
      sweepItems(later("2026-10-09"), "2026-10-09", { stale: false }).map((i) => i.id),
    ).toContain("wait:d-over");
  });

  test("the weekly pass is due when it never ran or ran seven days ago", () => {
    const now = new Date(NOW);
    expect(stalePassDue(null, now)).toBe(true);
    expect(stalePassDue("garbage", now)).toBe(true);
    expect(stalePassDue("2026-10-04T09:00:00.000Z", now)).toBe(false);
    expect(stalePassDue("2026-09-30T09:00:00.000Z", now)).toBe(true);
  });

  test("the summary counts what was done and what was left", () => {
    expect(sweepSummary(["done", "skipped", "done", "nudged"], 6)).toBe(
      "2 done, 1 nudged, 1 skipped, 2 left",
    );
    expect(sweepSummary([], 0)).toBe("Nothing to sweep");
    expect(sweepSummary(["dropped", "snoozed"], 2)).toBe("1 snoozed, 1 dropped");
  });
});

describe("the sweep's session: one action at a time, by item id", () => {
  const T = 1_000_000;
  const settled = T + SWEEP_SETTLE_MS;
  const fresh = () => startSweep(["A", "B", "C"], T);
  const begin = (s: SweepSession, id: string, now = settled) => {
    const next = beginAction(s, id, now);
    if (!next) throw new Error(`could not begin ${id}`);
    return next;
  };

  test("while an action runs, no second one starts: a second Enter or click does nothing", () => {
    const running = begin(fresh(), "A");
    expect(beginAction(running, "A", settled)).toBeNull();
    expect(changeMode(running, "drop", settled)).toBe(running);
    expect(skipShown(running, settled)).toBe(running);
  });

  test("a success moves on from the item it was for, once", () => {
    const one = settleAction(begin(fresh(), "A"), "A", "done", settled + 50);
    expect([shownId(one), one.busy, one.outcomes]).toEqual(["B", null, { A: "done" }]);
    // A repeated or late success for A neither moves past B nor labels it.
    const again = settleAction(one, "A", "done", settled + 60);
    expect([shownId(again), again.outcomes]).toEqual(["B", { A: "done" }]);
    expect(sweepOutcomes(again)).toEqual(["done"]);
  });

  test("a failure keeps the item; a choice keeps it in the choice's mode", () => {
    const failed = releaseAction(begin(fresh(), "A"), "A");
    expect([shownId(failed), failed.busy, failed.mode]).toEqual(["A", null, "idle"]);
    const choosing = releaseAction(begin(fresh(), "A"), "A", "done");
    expect([shownId(choosing), choosing.mode]).toEqual(["A", "done"]);
  });

  test("right after the item changes, actions are ignored for a moment (a double-click's second click)", () => {
    const moved = settleAction(begin(fresh(), "A"), "A", "snoozed", settled);
    expect(canAct(moved, "B", settled + 100)).toBe(false);
    expect(beginAction(moved, "B", settled + 100)).toBeNull();
    expect(skipShown(moved, settled + 100)).toBe(moved);
    expect(changeMode(moved, "snooze", settled + 100)).toBe(moved);
    expect(canAct(moved, "B", settled + SWEEP_SETTLE_MS)).toBe(true);
    // The first item too, right after the sweep opens.
    expect(canAct(fresh(), "A", T + 10)).toBe(false);
  });

  test("Space skips one item per press; a skipped item can still be acted on from a Retry", () => {
    const skipped = skipShown(fresh(), settled);
    expect([shownId(skipped), skipped.outcomes]).toEqual(["B", { A: "skipped" }]);
    expect(skipShown(skipped, settled + 1)).toBe(skipped);
    expect(canAct(skipped, "A", settled + 1)).toBe(true);
    const retried = settleAction(begin(skipped, "A", settled + 1), "A", "dropped", settled + 2);
    expect([shownId(retried), retried.outcomes.A]).toEqual(["B", "dropped"]);
    // A decided item is never acted on twice.
    expect(canAct(retried, "A", settled + 3)).toBe(false);
  });

  test("Esc backs out of a choice even inside the settle time, never while busy", () => {
    const choosing = changeMode(fresh(), "snooze", settled);
    expect(choosing.mode).toBe("snooze");
    expect(changeMode(choosing, "idle", settled).mode).toBe("idle");
    const busy = begin(choosing, "A");
    expect(changeMode(busy, "idle", settled).mode).toBe("snooze");
  });
});

describe("the sweep's keys", () => {
  const key = (k: string, p: Partial<Parameters<typeof sweepKey>[0]> = {}) => ({
    key: k,
    repeat: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...p,
  });

  test("letters and Space act on the item only with focus on the sweep's body", () => {
    expect(sweepKey(key("d"), "idle", true)).toEqual({ do: "done" });
    expect(sweepKey(key("X"), "idle", true)).toEqual({ do: "drop" });
    expect(sweepKey(key(" "), "idle", true)).toEqual({ do: "skip" });
    // On a focused button Space presses the button, not skip.
    expect(sweepKey(key(" "), "idle", false)).toBeNull();
    expect(sweepKey(key("d"), "idle", false)).toBeNull();
    expect(sweepKey(key("d", { ctrlKey: true }), "idle", true)).toBeNull();
  });

  test("a held key's auto-repeat never acts", () => {
    expect(sweepKey(key("d", { repeat: true }), "idle", true)).toBeNull();
    expect(sweepKey(key(" ", { repeat: true }), "idle", true)).toBeNull();
    expect(sweepKey(key("2", { repeat: true }), "snooze", true)).toBeNull();
    const enter = { ...key("Enter"), shiftKey: false };
    expect(submitsReason(enter)).toBe(true);
    expect(submitsReason({ ...enter, repeat: true })).toBe(false);
    expect(submitsReason({ ...enter, shiftKey: true })).toBe(false);
    expect(submitsReason({ ...enter, isComposing: true })).toBe(false);
  });

  test("in a choice, 1 to 9 pick and letters do nothing", () => {
    expect(sweepKey(key("2"), "done", true)).toEqual({ do: "pick", n: 1 });
    expect(sweepKey(key("d"), "snooze", true)).toBeNull();
    expect(sweepKey(key("1"), "idle", true)).toBeNull();
    expect(sweepKey(key("d"), "drop", true)).toBeNull();
  });
});

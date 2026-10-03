import { describe, expect, test } from "bun:test";
import { DEFAULT_WEIGHTS } from "@/services/settings/schema";
import { ask, mixedInputs, NOW, TODAY } from "@/test/today-fixture";
import { stalePassDue, sweepItems, sweepSummary } from "./sweep";
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
    const later = buildToday(
      mixedInputs({
        dependencies: mixedInputs().dependencies.map((d) =>
          d.id === "d-over" ? { ...d, nextFollowupAt: "2026-10-09" } : d,
        ),
      }),
      DEFAULT_WEIGHTS,
      TODAY,
      NOW,
    );
    const swept = sweepItems(later, TODAY, { stale: false }).map((i) => i.id);
    expect(swept).not.toContain("wait:d-over");
    // Still first in Their move: it is overdue.
    expect(later.theirMove[0]?.kind === "wait" && later.theirMove[0].dependency.id).toBe("d-over");
    expect(sweepItems(later, "2026-10-09", { stale: false }).map((i) => i.id)).toContain(
      "wait:d-over",
    );
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

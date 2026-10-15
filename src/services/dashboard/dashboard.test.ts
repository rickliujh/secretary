import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { jiraIssues, llmCalls } from "@/db/schema";
import { query } from "@/services/db";
import { createDependency } from "@/services/dependencies/queries";
import { DEFAULT_WEIGHTS } from "@/services/settings/schema";
import { promptOf } from "@/test/helpers";
import { intakeTestLayer, out } from "@/test/intake-layer";
import { syncOnce } from "@/test/seed";
import { generateBrief, todayWithBrief } from "./brief";
import {
  loadDashboardInputs,
  loadEpicHealth,
  loadToday,
  setOverride,
  setPinned,
  snooze,
} from "./data";
import { rankWork } from "./sections";
import type { WaitRow } from "./today";

// Wednesday 24 September 2026, mid-morning.
const NOW = new Date("2026-09-24T09:00:00.000Z");
const TODAY = "2026-09-24";

const seedWork = Effect.gen(function* () {
  yield* syncOnce;
  // PAY-4 (assigned to me, under the tracked epic) is due in two days.
  yield* query((d) =>
    d.update(jiraIssues).set({ dueDate: "2026-09-26" }).where(eq(jiraIssues.key, "PAY-4")),
  );
  yield* createDependency({
    issueKey: "PAY-2",
    kind: "incident",
    label: "Platform fix",
    externalRef: "INC0012345",
    expectedAt: "2026-09-21",
  });
});

const brief = {
  changed: "- PAY-2 got a comment from Tom.",
  doFirst: "- Finish PAY-4, due Friday.",
  chase: "- Platform about INC0012345 for PAY-2.",
};

describe("Today from the local cache", () => {
  test("loads the cache into the three lists: sprint work, due soon, waits", async () => {
    const { layer } = intakeTestLayer({});
    const t = await Effect.runPromise(
      Effect.provide(Effect.zipRight(seedWork, loadToday(NOW)), layer),
    );
    // PAY-2 is in the active sprint "Payments 15"; PAY-4 is not, so it is not in
    // Top focus (D29) but joins Sprint work as due soon.
    expect(t.focus).toEqual({ mode: "sprint", sprints: ["Payments 15"], endsOn: "2026-09-28" });
    expect(t.facts.topFocus.map((x) => x.key)).toEqual(["PAY-2"]);
    expect(t.facts.dueSoon.map((x) => [x.key, x.daysLeft])).toEqual([["PAY-4", 2]]);
    const waits = t.theirMove.filter((r): r is WaitRow => r.kind === "wait");
    expect(waits.map((w) => [w.dependency.externalRef, w.state, w.reason])).toEqual([
      ["INC0012345", "overdue", "3 days overdue"],
    ]);
    // PAY-2 (Ana's, with the wait) has a "blocked by OPS-7" link: only the user's
    // own blocked tickets are Their move, so it stays Sprint work, blocked and at risk.
    expect(t.theirMove.map((r) => r.kind)).toEqual(["wait"]);
    expect(t.facts.topFocus[0]?.contributions.map((c) => c.reason)).toEqual(
      expect.arrayContaining([
        "Blocked by OPS-7",
        "Waiting on Platform fix (INC0012345), 3 days overdue",
      ]),
    );
    expect(
      t.sprintWork.map((r) => [r.issue.key, r.inFocus, r.daysLeft, r.risks[0] ?? null]),
    ).toEqual([
      ["PAY-2", true, null, "Blocked by OPS-7"],
      ["PAY-4", false, 2, "Due in 2 days and not started"],
    ]);
    // No small-asks home in this layer.
    expect(t.smallAsks.home).toBe(false);
  });

  test("epic health loads on its own for Sprint > Epics (D50)", async () => {
    const { layer } = intakeTestLayer({});
    const epics = await Effect.runPromise(
      Effect.provide(Effect.zipRight(seedWork, loadEpicHealth(NOW)), layer),
    );
    expect(epics).toEqual([
      expect.objectContaining({ key: "PAY-1", total: 2, done: 0, inProgress: 1, todo: 1 }),
    ]);
  });

  test("pin, snooze and override change the local ranking only", async () => {
    const { layer, seen } = intakeTestLayer({});
    const order = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* seedWork;
          // Without sprints, so the whole scope is ranked and the local controls show.
          const rank = Effect.map(loadDashboardInputs(NOW), (i) =>
            rankWork({ ...i, sprints: [] }, DEFAULT_WEIGHTS, TODAY, NOW.toISOString()),
          );
          const before = (yield* rank).topFocus.map((t) => t.key);
          yield* setOverride("PAY-4", 20);
          const boosted = (yield* rank).topFocus.map((t) => t.key);
          yield* snooze("PAY-4", "2026-09-25T00:00:00.000Z");
          const snoozed = yield* rank;
          yield* setPinned("OPS-7", true);
          const pinned = (yield* rank).topFocus.map((t) => t.key);
          return { before, boosted, snoozed, pinned };
        }),
        layer,
      ),
    );
    expect(order.before[0]).toBe("PAY-2");
    expect(order.boosted[0]).toBe("PAY-4");
    expect(order.snoozed.topFocus.map((t) => t.key)).toEqual(["PAY-2"]);
    expect(order.snoozed.snoozed).toBe(1);
    expect(order.pinned[0]).toBe("OPS-7");
    // Nothing was written to Jira.
    expect(seen.filter((s) => s.method !== "GET" && !s.url.endsWith("/search"))).toEqual([]);
  });
});

describe("daily brief", () => {
  test("must mention the overdue incident and due-soon work; repaired if not; cached until data changes", async () => {
    const missing = { ...brief, chase: "- Nobody to chase." };
    const { layer, models } = intakeTestLayer({ "std-m": [out(missing), out(brief)] });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* seedWork;
          const generated = yield* generateBrief(NOW);
          const after = yield* todayWithBrief(NOW);
          yield* query((d) =>
            d
              .update(jiraIssues)
              .set({ updated: "2026-09-24T10:00:00.000Z" })
              .where(eq(jiraIssues.key, "PAY-4")),
          );
          const changed = yield* todayWithBrief(new Date("2026-09-24T11:00:00.000Z"));
          const calls = yield* query((d) => d.select().from(llmCalls).all());
          return { generated, after, changed, calls };
        }),
        layer,
      ),
    );
    expect(r.generated.sections.chase).toContain("INC0012345");
    expect(r.calls.map((c) => [c.task, c.validationOk])).toEqual([
      ["daily_brief", false],
      ["repair_output", true],
    ]);
    const prompt = promptOf(models.calls, 0);
    expect(prompt).toContain(
      "PAY-2 waits on Platform fix (INC0012345), owner No owner, 3 days overdue",
    );
    expect(prompt).toContain("PAY-4");
    expect(r.after.briefFresh).toBe(true);
    expect(r.changed.briefFresh).toBe(false);
  });

  test("with nothing to report there is no model call", async () => {
    const { layer, models } = intakeTestLayer({});
    const b = await Effect.runPromise(Effect.provide(generateBrief(NOW), layer));
    expect(b.sections.doFirst).toBe("Nothing is urgent.");
    expect(models.calls).toHaveLength(0);
  });
});

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
import { dashboardWithBrief, generateBrief, periodStart } from "./brief";
import { loadDashboardInputs, setOverride, setPinned, snooze } from "./data";
import { buildDashboard } from "./sections";

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

describe("dashboard data", () => {
  test("loads the cache into sections: focus, due soon, waiting, epic health", async () => {
    const { layer } = intakeTestLayer({});
    const d = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* seedWork;
          return buildDashboard(
            yield* loadDashboardInputs(NOW),
            DEFAULT_WEIGHTS,
            TODAY,
            NOW.toISOString(),
          );
        }),
        layer,
      ),
    );
    // PAY-2 is in the active sprint "Payments 15"; PAY-4 is not, so it leaves Top
    // focus (D29) but still shows as due soon.
    expect(d.focus).toEqual({ mode: "sprint", sprints: ["Payments 15"], endsOn: "2026-09-28" });
    expect(d.topFocus.map((t) => t.key)).toEqual(["PAY-2"]);
    expect(d.dueSoon.map((x) => [x.key, x.daysLeft])).toEqual([["PAY-4", 2]]);
    expect(d.iAmWaitingOn.map((x) => [x.externalRef, x.overdueDays])).toEqual([["INC0012345", 3]]);
    const pay2 = d.topFocus.find((t) => t.key === "PAY-2");
    // PAY-2 has a "blocked by OPS-7" link in the fixtures and a Blocked status.
    expect(pay2?.contributions.map((c) => c.reason)).toEqual(
      expect.arrayContaining([
        "Blocked by OPS-7",
        "Waiting on Platform fix (INC0012345), 3 days overdue",
      ]),
    );
    expect(d.epicHealth[0]).toMatchObject({
      key: "PAY-1",
      total: 2,
      done: 0,
      inProgress: 1,
      todo: 1,
      blocked: 1,
    });
  });

  test("pin, snooze and override change the local ranking only", async () => {
    const { layer, seen } = intakeTestLayer({});
    const order = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* seedWork;
          // Without sprints, so the whole scope is ranked and the local controls show.
          const rank = Effect.map(loadDashboardInputs(NOW), (i) =>
            buildDashboard({ ...i, sprints: [] }, DEFAULT_WEIGHTS, TODAY, NOW.toISOString()),
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
          const after = yield* dashboardWithBrief(NOW);
          yield* query((d) =>
            d
              .update(jiraIssues)
              .set({ updated: "2026-09-24T10:00:00.000Z" })
              .where(eq(jiraIssues.key, "PAY-4")),
          );
          const changed = yield* dashboardWithBrief(new Date("2026-09-24T11:00:00.000Z"));
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

  test("a chosen period covers its days and still counts as fresh (D37)", async () => {
    const { layer, models } = intakeTestLayer({ "std-m": [out(brief)] });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* seedWork;
          const generated = yield* generateBrief(NOW, 7);
          return { generated, after: yield* dashboardWithBrief(NOW) };
        }),
        layer,
      ),
    );
    const start = periodStart(NOW, 7);
    expect(r.generated).toMatchObject({ days: 7, since: start.toISOString() });
    const prompt = promptOf(models.calls, 0);
    expect(prompt).toContain(
      `## Changed in the last 7 days (since ${start.toLocaleDateString("en-CA")})`,
    );
    expect(prompt).toContain("catch-up report");
    expect(r.after.briefFresh).toBe(true);
  });

  test("periods start at local midnight; 1 day is the start of yesterday", () => {
    const now = new Date(2026, 8, 24, 15, 30);
    expect(periodStart(now, 1)).toEqual(new Date(2026, 8, 23, 0, 0));
    expect(periodStart(now, 7)).toEqual(new Date(2026, 8, 17, 0, 0));
  });
});

import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { jiraIssues, proposals } from "@/db/schema";
import { query } from "@/services/db";
import { Intake } from "@/services/intake";
import { getState, parseSprintState, SYNC_KEYS, setState } from "@/services/sync/state";
import { intakeTestLayer, out } from "@/test/intake-layer";
import { syncOnce } from "@/test/seed";
import { Planning } from ".";

const TODAY = "2026-09-25";

/** The fixtures after a sync, shaped into a planning situation for rliu. */
const setup = (withNextSprint: boolean) =>
  Effect.gen(function* () {
    yield* syncOnce;
    const set = (key: string, v: Partial<typeof jiraIssues.$inferInsert>) =>
      query((d) => d.update(jiraIssues).set(v).where(eq(jiraIssues.key, key)));
    // PAY-2: unfinished in the active sprint (carry-over), blocked by OPS-7 in the fixtures.
    yield* set("PAY-2", { assignee: "rliu", sprint: "Payments 15" });
    // PAY-3: finished by rliu inside Payments 14, for velocity.
    yield* set("PAY-3", { assignee: "rliu", resolved: "2026-09-10T10:00:00.000Z", storyPoints: 3 });
    // OPS-7: unassigned under the tracked epic PAY-1, so an optional pickup.
    yield* set("OPS-7", { assignee: null, epicKey: "PAY-1" });
    if (withNextSprint) {
      const state = parseSprintState(yield* getState(SYNC_KEYS.sprints));
      yield* setState(
        SYNC_KEYS.sprints,
        JSON.stringify({
          ...state,
          sprints: [
            ...state.sprints,
            {
              id: 43,
              name: "Payments 16",
              state: "future",
              boardId: 7,
              start: "2026-09-28",
              end: "2026-10-12",
            },
          ],
        }),
      );
    }
  });

const plan = {
  goal: "Unblock the ledger export and fix refund rounding",
  picks: [
    { key: "PAY-2", reason: "carry over, nearly done" },
    { key: "PAY-4", reason: "customer-facing bug" },
  ],
  deferred: [],
  risks: ["PAY-2 waits on OPS-7"],
};

describe("Planning (D30)", () => {
  test("prepares candidates and velocity, drafts a checked plan, proposes sprint moves in a planner thread", async () => {
    const { layer, models } = intakeTestLayer({ "std-m": [out(plan)] });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* setup(true);
          const planning = yield* Planning;
          const prep = yield* planning.prepare(TODAY);
          const drafted = yield* planning.draft({
            capacity: 8,
            instructions: ["Friday is a release freeze"],
            today: TODAY,
          });
          const proposed = yield* planning.propose({
            goal: drafted.plan.goal,
            picks: drafted.plan.picks.map((p) => p.key),
            deferred: [],
            risks: drafted.plan.risks,
          });
          const rows = yield* query((d) =>
            d.select().from(proposals).where(eq(proposals.inboxItemId, proposed.inboxItemId)).all(),
          );
          const replied = yield* Effect.either(
            (yield* Intake).reply({ inboxItemId: proposed.inboxItemId, instruction: "add PAY-9" }),
          );
          return { prep, drafted, proposed, rows, replied };
        }),
        layer,
      ),
    );
    expect(r.prep.ending?.name).toBe("Payments 15");
    expect(r.prep.next).toMatchObject({ id: 43, name: "Payments 16" });
    expect(r.prep.candidates.map((c) => [c.key, c.group])).toEqual([
      ["PAY-2", "carry_over"],
      ["PAY-4", "backlog"],
      ["OPS-7", "pickup"],
    ]);
    expect(r.prep.velocity.sprints[0]).toEqual({
      name: "Payments 14",
      points: 3,
      issues: 1,
      unestimated: 0,
    });
    expect(r.prep.endingSummary).toEqual({ committed: 5, done: 0, open: 1, unestimated: 0 });
    const prompt = JSON.stringify(models.calls[0]?.prompt);
    expect(prompt).toContain("8 story points");
    expect(prompt).toContain("Friday is a release freeze");
    expect(prompt).toContain("blocked by OPS-7");
    expect(r.drafted.plan).toMatchObject({ points: 7, unestimated: [] });
    expect(r.proposed).toMatchObject({ proposals: 2, alreadyThere: [] });
    expect(r.rows.map((p) => [p.kind, p.payload])).toEqual([
      [
        "move_to_sprint",
        { kind: "move_to_sprint", target: "PAY-2", sprintId: 43, sprintName: "Payments 16" },
      ],
      [
        "move_to_sprint",
        { kind: "move_to_sprint", target: "PAY-4", sprintId: 43, sprintName: "Payments 16" },
      ],
    ]);
    expect(r.replied._tag === "Left" && (r.replied.left as { kind: string }).kind).toBe(
      "read_only",
    );
  });

  test("a plan that ignores a carry-over or blows the capacity is repaired", async () => {
    const bad = { ...plan, picks: [{ key: "PAY-4", reason: "bug" }], risks: [] };
    const { layer, models } = intakeTestLayer({ "std-m": [out(bad), out(plan)] });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* setup(true);
          return yield* (yield* Planning).draft({ capacity: 8, instructions: [], today: TODAY });
        }),
        layer,
      ),
    );
    expect(JSON.stringify(models.calls[1]?.prompt)).toContain(
      "Decide these unfinished tickets (pick or defer): PAY-2.",
    );
    expect(r.plan.picks.map((p) => p.key)).toEqual(["PAY-2", "PAY-4"]);
  });

  test("without a next sprint in Jira the plan cannot be sent", async () => {
    const { layer } = intakeTestLayer({});
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* setup(false);
          return yield* Effect.either(
            (yield* Planning).propose({ goal: "g", picks: ["PAY-4"], deferred: [], risks: [] }),
          );
        }),
        layer,
      ),
    );
    expect(r._tag === "Left" && (r.left as { kind: string }).kind).toBe("no_sprint");
  });
});

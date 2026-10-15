import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { jiraIssues } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { query } from "@/services/db";
import { DbTest } from "@/services/db/test";
import { type PointUse, pointScale, pointUses } from "./points";

describe("pointUses (the cache's point values)", () => {
  test("counts per project and value; stale tickets, epics, sub-tasks and unestimated left out", async () => {
    const row = (
      key: string,
      storyPoints: number | null,
      extra: Partial<typeof jiraIssues.$inferInsert> = {},
    ) => ({
      key,
      id: key,
      projectKey: key.split("-")[0] ?? "",
      issueType: "Story",
      summary: key,
      status: "To Do",
      statusCategory: "new" as const,
      storyPoints,
      created: nowIso(),
      updated: nowIso(),
      syncedAt: nowIso(),
      ...extra,
    });
    const uses = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* query((d) =>
            d
              .insert(jiraIssues)
              .values([
                row("PAY-1", 3),
                row("PAY-2", 3),
                row("PAY-3", 5),
                row("PAY-4", 8, { stale: true }),
                row("PAY-5", 13, { issueType: "Epic" }),
                row("PAY-6", 1, { issueType: "Sub-task", isSubtask: true }),
                row("PAY-7", null),
                row("OPS-1", 2),
              ]),
          );
          return yield* pointUses;
        }),
        DbTest,
      ),
    );
    expect(
      [...uses].sort(
        (a, b) => a.projectKey.localeCompare(b.projectKey) || (a.points ?? 0) - (b.points ?? 0),
      ),
    ).toEqual([
      { projectKey: "OPS", points: 2, count: 1 },
      { projectKey: "PAY", points: 3, count: 2 },
      { projectKey: "PAY", points: 5, count: 1 },
    ]);
    expect(pointScale(uses, ["PAY"])).toEqual([3, 5]);
  });
});

const use = (projectKey: string, points: number | null, count: number): PointUse => ({
  projectKey,
  points,
  count,
});

describe("pointScale (D55)", () => {
  test("the projects in play first, sorted ascending", () => {
    const uses = [use("PAY", 5, 4), use("PAY", 2, 1), use("OPS", 13, 9), use("PAY", 3, 2)];
    expect(pointScale(uses, ["PAY"])).toEqual([2, 3, 5]);
  });

  test("every cached project when those in play have no points", () => {
    const uses = [use("PAY", 5, 4), use("OPS", 13, 9)];
    expect(pointScale(uses, ["ASK"])).toEqual([5, 13]);
    expect(pointScale(uses, [])).toEqual([5, 13]);
  });

  test("counts add up across projects in play; the 8 most frequent, ties the smaller", () => {
    const uses = [
      ...[1, 2, 3, 5, 8, 13, 21, 40, 100].map((p, i) => use("PAY", p, 10 - i)),
      use("OPS", 100, 50),
      // As frequent as 21: 0.5 is smaller, so it takes the last place.
      use("OPS", 0.5, 4),
    ];
    expect(pointScale(uses, ["PAY", "OPS"])).toEqual([0.5, 1, 2, 3, 5, 8, 13, 100]);
  });

  test("empty without points; nulls, negatives and empty counts are ignored", () => {
    expect(pointScale([], ["PAY"])).toEqual([]);
    expect(pointScale([use("PAY", null, 3), use("PAY", -1, 2), use("PAY", 3, 0)], ["PAY"])).toEqual(
      [],
    );
  });
});

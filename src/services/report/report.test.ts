import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { jiraIssues, llmCalls } from "@/db/schema";
import { query } from "@/services/db";
import { promptOf } from "@/test/helpers";
import { intakeTestLayer, out } from "@/test/intake-layer";
import { syncOnce } from "@/test/seed";
import { json } from "@/test/stub-fetch";
import { Reports } from ".";

const now = new Date();
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3_600_000).toISOString();

const report = {
  talkTrack:
    "I finished the refund rounding fix, PAY-3. The ledger export, PAY-2, is in review but waits on OPS-7.",
  headline: "Refund rounding done; ledger export waits on OPS-7.",
  tickets: [
    { key: "PAY-3", happened: "", next: "" },
    { key: "PAY-2", happened: "Moved to review.", next: "Chase OPS-7" },
  ],
};

describe("recap report (D37)", () => {
  test("facts from the cache and Jira history; finished and blocked tickets must be named", async () => {
    const { layer, models } = intakeTestLayer(
      { "std-m": [out({ ...report, talkTrack: "I finished PAY-3." }), out(report)] },
      [
        {
          match: (u) =>
            u.pathname.endsWith("/issue/PAY-2") &&
            (u.searchParams.get("expand") ?? "").includes("changelog"),
          respond: () =>
            json({
              id: "10002",
              key: "PAY-2",
              fields: { summary: "Ledger export" },
              changelog: {
                startAt: 0,
                maxResults: 1,
                total: 1,
                histories: [
                  {
                    id: "1",
                    author: { name: "rliu", displayName: "Rick Liu" },
                    created: hoursAgo(2),
                    items: [
                      {
                        field: "status",
                        fieldtype: "jira",
                        from: "3",
                        fromString: "In Progress",
                        to: "10001",
                        toString: "In Review",
                      },
                    ],
                  },
                ],
              },
            }),
        },
        {
          match: (u) => u.pathname.endsWith("/issue/PAY-3"),
          respond: () => new Response("boom", { status: 500 }),
        },
      ],
    );
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const set = (key: string, v: Partial<typeof jiraIssues.$inferInsert>) =>
            query((d) => d.update(jiraIssues).set(v).where(eq(jiraIssues.key, key)));
          yield* set("PAY-2", { assignee: "rliu", updated: hoursAgo(2) });
          yield* set("PAY-3", {
            assignee: "rliu",
            status: "Done",
            statusCategory: "done",
            resolved: hoursAgo(3),
            updated: hoursAgo(3),
            storyPoints: 3,
          });
          const reports = yield* Reports;
          const made = yield* reports.generate({
            period: { kind: "days", days: 1 },
            scope: "mine",
          });
          const calls = yield* query((d) => d.select().from(llmCalls).all());
          return { made, last: yield* reports.last, calls };
        }),
        layer,
      ),
    );
    const group = (g: string) => r.made.tickets.filter((t) => t.group === g).map((t) => t.key);
    expect(group("done")).toEqual(["PAY-3"]);
    expect(group("blocked")).toEqual(["PAY-2"]);
    expect(r.made.historyMissing).toEqual(["PAY-3"]);
    expect(r.made.stats).toMatchObject({ done: 1, pointsDone: 3 });
    expect(r.made.periodLabel).toBe("Since yesterday");
    // The first answer left out the blocked ticket and was repaired.
    expect(r.calls.map((c) => [c.task, c.validationOk])).toEqual([
      ["write_report", false],
      ["repair_output", true],
    ]);
    expect(promptOf(models.calls, 0)).toContain("PAY-3");
    expect(r.made.talkTrack).toContain("OPS-7");
    expect(r.made.tickets.find((t) => t.key === "PAY-2")).toMatchObject({
      happened: "Moved to review.",
      next: "Chase OPS-7",
    });
    expect(r.made.tickets.find((t) => t.key === "PAY-2")?.events.map((e) => e.text)).toContain(
      "In Progress -> In Review",
    );
    expect(r.last?.generatedAt).toBe(r.made.generatedAt);
  });

  test("a quiet period needs no model call", async () => {
    const { layer, models } = intakeTestLayer({});
    const made = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          // Nobody's work is mine.
          yield* query((d) => d.update(jiraIssues).set({ assignee: "ana", reporter: "ana" }));
          return yield* (yield* Reports).generate({ period: { kind: "workday" }, scope: "mine" });
        }),
        layer,
      ),
    );
    expect(made.talkTrack).toBe("Nothing to report for this period.");
    expect(models.calls).toHaveLength(0);
  });
});

import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { ulid } from "ulidx";
import { inboxItems, intakeItems, jiraComments, jiraIssues, llmCalls } from "@/db/schema";
import { query } from "@/services/db";
import { syncedJiraLayer, syncOnce } from "@/test/seed";
import { cleanup, cleanupIfDue, lastCleanup, storageLevel, ulidAt } from "./retention";

const NOW = new Date("2026-09-26T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe("storage cleanup (D34)", () => {
  test("drops old usage rows, long-stale tickets and old snapshots; keeps the rest", async () => {
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const call = (id: string, at: Date): typeof llmCalls.$inferInsert => ({
            id,
            task: "chat",
            tier: "standard" as const,
            providerId: "p",
            model: "m",
            escalated: false,
            repair: false,
            durationMs: 1,
            ok: true,
            at: at.toISOString(),
          });
          yield* query((d) =>
            d.insert(llmCalls).values([call("old", daysAgo(91)), call("new", daysAgo(5))]),
          );
          // PAY-3 left Jira 40 days ago, OPS-7 only 3 days ago; PAY-4 is still synced.
          yield* query((d) =>
            d
              .update(jiraIssues)
              .set({ stale: true, syncedAt: daysAgo(40).toISOString() })
              .where(eq(jiraIssues.key, "PAY-3")),
          );
          yield* query((d) =>
            d
              .update(jiraIssues)
              .set({ stale: true, syncedAt: daysAgo(3).toISOString() })
              .where(eq(jiraIssues.key, "OPS-7")),
          );
          yield* query((d) =>
            d.insert(inboxItems).values({
              id: "t1",
              source: "teams",
              rawText: "x",
              receivedAt: NOW.toISOString(),
              status: "triaged",
            }),
          );
          const item = (id: string) => ({
            id,
            inboxItemId: "t1",
            idx: 0,
            quote: "q",
            snapshot: { candidates: [], big: "x".repeat(1000) },
            promptVersion: 5,
          });
          const oldId = ulid(daysAgo(200).getTime());
          const newId = ulid(daysAgo(10).getTime());
          yield* query((d) => d.insert(intakeItems).values([item(oldId), item(newId)]));

          const result = yield* cleanup(NOW);
          const soon = yield* cleanupIfDue(new Date(NOW.getTime() + 3_600_000));
          const nextDay = yield* cleanupIfDue(new Date(NOW.getTime() + 21 * 3_600_000));
          return {
            result,
            soon,
            nextDay,
            last: yield* lastCleanup,
            calls: (yield* query((d) => d.select().from(llmCalls).all())).map((c) => c.id),
            issues: (yield* query((d) =>
              d.select({ key: jiraIssues.key }).from(jiraIssues).all(),
            )).map((i) => i.key),
            comments: (yield* query((d) =>
              d.select().from(jiraComments).where(eq(jiraComments.issueKey, "PAY-3")).all(),
            )).length,
            snapshots: yield* query((d) =>
              d
                .select({ id: intakeItems.id, snapshot: intakeItems.snapshot })
                .from(intakeItems)
                .all(),
            ),
            oldId,
          };
        }),
        syncedJiraLayer().layer,
      ),
    );
    expect(r.result).toMatchObject({ llmCalls: 1, staleIssues: 1, snapshots: 1 });
    expect(r.result.bytes).toBeGreaterThan(0);
    expect(r.calls).toEqual(["new"]);
    expect(r.issues).not.toContain("PAY-3");
    expect(r.issues).toContain("OPS-7");
    expect(r.comments).toBe(0);
    expect(r.snapshots.find((s) => s.id === r.oldId)?.snapshot).toEqual({ pruned: true });
    expect(r.snapshots.filter((s) => !(s.snapshot as { pruned?: boolean }).pruned)).toHaveLength(1);
    // Auto cleanup skips within 20 hours of the last one, then runs again.
    expect(r.soon).toBeNull();
    expect(r.nextDay).toMatchObject({ llmCalls: 0, staleIssues: 0, snapshots: 0 });
    // The last result is kept for Settings.
    expect(r.last?.at).toBe(new Date(NOW.getTime() + 21 * 3_600_000).toISOString());
  });

  test("storage level against the user's limit", () => {
    const mb = 1024 * 1024;
    expect(storageLevel(100 * mb, 500)).toBe("ok");
    expect(storageLevel(460 * mb, 500)).toBe("near");
    expect(storageLevel(500 * mb, 500)).toBe("over");
  });

  test("ulidAt is the smallest ULID of that moment", () => {
    const t = Date.parse("2026-03-01T08:00:00.000Z");
    expect(ulidAt(new Date(t)).slice(0, 10)).toBe(ulid(t).slice(0, 10));
    expect(ulidAt(new Date(t)) < ulid(t)).toBe(true);
    expect(ulid(t - 1) < ulidAt(new Date(t))).toBe(true);
  });
});

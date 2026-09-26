import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { Sync } from "@/services/sync";
import { syncedJiraLayer } from "@/test/seed";
import { listTicketRows, markViewed, searchTicketKeys, ticketDetail } from "./queries";

describe("ticket queries", () => {
  test("list, search, detail and viewed marker over a synced cache", async () => {
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* (yield* Sync).run();
          const rows = yield* listTicketRows;
          const ledger = yield* searchTicketKeys("ledg");
          const byKey = yield* searchTicketKeys("pay-4");
          yield* markViewed("PAY-2");
          const detail = yield* ticketDetail("PAY-2");
          const missing = yield* ticketDetail("NOPE-1");
          return { rows, ledger, byKey, detail, missing };
        }),
        syncedJiraLayer().layer,
      ),
    );
    expect(r.rows).toHaveLength(5);
    expect(r.rows[0]).not.toHaveProperty("raw");
    expect([...r.ledger].sort()).toEqual(["OPS-7", "PAY-2", "PAY-3"]);
    expect(r.byKey.has("PAY-4")).toBe(true);
    expect(r.detail?.comments.map((c) => c.id)).toEqual(["50001", "50002", "50003"]);
    expect(r.detail?.meta?.lastViewedAt).toBeTruthy();
    expect(r.missing).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { Sync } from "@/services/sync";
import { SyncLive } from "@/services/sync/live";
import comments from "@/test/fixtures/jira/comments-PAY-2.json";
import fields from "@/test/fixtures/jira/field.json";
import myself from "@/test/fixtures/jira/myself.json";
import page1 from "@/test/fixtures/jira/search-page-1.json";
import page2 from "@/test/fixtures/jira/search-page-2.json";
import { jiraSettings, jiraTestLayer } from "@/test/layers";
import { json, stubFetch } from "@/test/stub-fetch";
import { listTicketRows, markViewed, searchTicketKeys, ticketDetail } from "./queries";

const all = [...page1.issues, ...page2.issues];

const layer = () => {
  const stub = stubFetch([
    { match: (u) => u.pathname.endsWith("/myself"), respond: () => json(myself) },
    { match: (u) => u.pathname.endsWith("/field"), respond: () => json(fields) },
    { match: (u) => u.pathname.endsWith("/comment"), respond: () => json(comments) },
    {
      match: (u) => u.pathname.endsWith("/search"),
      respond: (r) => {
        const b = r.body as { startAt: number; jql: string };
        const src = b.jql.startsWith("(parent in") ? [] : all;
        return json({
          startAt: b.startAt,
          maxResults: 100,
          total: src.length,
          issues: src.slice(b.startAt),
        });
      },
    },
  ]);
  return Layer.provideMerge(
    SyncLive,
    jiraTestLayer(stub.fetch, jiraSettings({ trackedEpics: ["PAY-1"] })),
  );
};

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
        layer(),
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

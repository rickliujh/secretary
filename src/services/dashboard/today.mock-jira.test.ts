/**
 * Today against the mock Jira over real HTTP (Phase 16 checklist): Done on a
 * small ask transitions it in Jira and the row leaves Your move; Drop closes
 * one with the reason as a comment (D43); Today builds from 2,000 synced
 * issues inside the FR-12 budget.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { issueMeta } from "@/db/schema";
import { query } from "@/services/db";
import { createPerson } from "@/services/directory/queries";
import { ExecutorLive } from "@/services/executor/live";
import { Sync } from "@/services/sync";
import { SyncLive } from "@/services/sync/live";
import { jiraSettings, jiraTestLayer } from "@/test/layers";
import { boardSprints, createHandler, generate } from "../../../scripts/mock-jira";
import { doneOptions, dropTicket, finishTicket } from "./actions";
import { loadToday } from "./data";

const servers: { stop: (force?: boolean) => void }[] = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

const ME = { name: "me", displayName: "Me Myself", emailAddress: "me@example.com" };

type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function setup(count: number, asks: number, wrap: (f: FetchFn) => FetchFn = (f) => f) {
  const issues = generate(count);
  const active = boardSprints(1).find((s) => s.state === "active");
  const open = [...issues.values()].filter(
    (i) => i.project === "PAY" && i.type === "Task" && i.status !== "Done",
  );
  if (!active || open.length < asks) throw new Error("fixture");
  // The user's small asks: assigned to them, with the home label, in the active sprint.
  for (const i of open.slice(0, asks)) {
    i.assignee = ME;
    i.labels = ["small-ask"];
    i.movedToSprint = active.id;
    i.status = "To Do";
    i.links = [];
  }
  const server = Bun.serve({ port: 0, fetch: createHandler(issues) });
  servers.push(server);
  const layer = Layer.provideMerge(
    ExecutorLive,
    Layer.provideMerge(
      SyncLive,
      jiraTestLayer(
        wrap((input, init) => fetch(input, init)),
        {
          ...jiraSettings({ baseUrl: `http://localhost:${server.port}`, trackedEpics: [] }),
          smallAsks: {
            projectKey: "PAY",
            label: "small-ask",
            joinActiveSprint: true,
            hintDismissed: false,
            defaultPoints: null,
          },
        },
      ),
    ),
  );
  return { issues, asks: open.slice(0, asks).map((i) => i.key), layer };
}

const yourMoveAsks = (t: Effect.Effect.Success<ReturnType<typeof loadToday>>) =>
  t.yourMove.flatMap((r) => (r.kind === "ask" ? [r.issue.key] : []));

describe("Today against the mock Jira", () => {
  test("Done on a small ask transitions it in Jira and the row leaves Your move; Drop closes one with the reason", async () => {
    const { issues, asks, layer } = setup(80, 2);
    const [done, dropped] = asks as [string, string];
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* (yield* Sync).run();
          const priya = yield* createPerson({ displayName: "Priya Shah" });
          yield* query((d) =>
            d.insert(issueMeta).values({ issueKey: done, requesterPersonId: priya }),
          );
          const before = yield* loadToday();
          const options = yield* doneOptions(done);
          const finished = yield* finishTicket(done, options[0] as (typeof options)[number]);
          const drop = yield* dropTicket(dropped, "the vendor answered it already");
          const after = yield* loadToday();
          return { before, options, finished, drop, after };
        }),
        layer,
      ),
    );
    expect(yourMoveAsks(r.before).sort()).toEqual([...asks].sort());
    const row = r.before.yourMove.find((x) => x.kind === "ask" && x.issue.key === done);
    expect(row?.reason).toMatch(/^asked by Priya Shah /);
    // The mock's workflow has one done status, so Done needs no menu.
    expect(r.options.map((o) => o.to.name)).toEqual(["Done"]);
    expect(r.finished).toEqual({ message: `${done} moved to Done`, warning: undefined });
    expect(issues.get(done)?.status).toBe("Done");
    // No cancel-like status in the mock: drop closes as Done and says it was not done.
    expect(r.drop.message).toBe(`${dropped} moved to Done with the reason`);
    expect(issues.get(dropped)?.status).toBe("Done");
    expect(issues.get(dropped)?.comments.at(-1)?.body).toContain(
      "Closed without being done: the vendor answered it already",
    );
    // The Executor refreshed both tickets, so the rows are gone at once.
    expect(yourMoveAsks(r.after)).toEqual([]);
    expect(r.after.smallAsks.open).toEqual([]);
  }, 30_000);

  test("Drop comments first; a failed move says the ticket is still open, and the retry does not comment twice", async () => {
    let failMoves = 1;
    const { issues, asks, layer } = setup(80, 1, (f) => async (input, init) => {
      const req = input instanceof Request ? input : null;
      const url = req ? req.url : String(input);
      const method = init?.method ?? req?.method;
      if (method === "POST" && url.endsWith("/transitions") && failMoves-- > 0)
        return Response.json(
          { errorMessages: ["Resolution is required."], errors: {} },
          { status: 400 },
        );
      return f(input, init);
    });
    const [key] = asks as [string];
    const before = issues.get(key)?.comments.length ?? 0;
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* (yield* Sync).run();
          const first = yield* Effect.either(dropTicket(key, "no longer needed"));
          const status = issues.get(key)?.status;
          const retry = yield* dropTicket(key, "no longer needed");
          return { first, status, retry };
        }),
        layer,
      ),
    );
    expect(r.first._tag).toBe("Left");
    if (r.first._tag === "Left") {
      expect(r.first.left.message).toContain(`${key} is still open; Retry closes it`);
      expect(r.first.left.message).toContain("Resolution is required.");
    }
    // The comment went first and stayed; the ticket did not move.
    expect(r.status).toBe("To Do");
    expect(r.retry.message).toBe(`${key} moved to Done with the reason`);
    expect(issues.get(key)?.status).toBe("Done");
    const comments = issues.get(key)?.comments ?? [];
    expect(comments.length).toBe(before + 1);
    expect(comments.at(-1)?.body).toContain("Closed without being done: no longer needed");
  }, 30_000);

  test("Today over 2,000 synced issues loads and builds within the 1 second budget (FR-12 AC)", async () => {
    const { layer } = setup(2000, 40);
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* (yield* Sync).run();
          const started = performance.now();
          const t = yield* loadToday();
          return { ms: performance.now() - started, t };
        }),
        layer,
      ),
    );
    console.log(`Today over 2,000 issues: ${r.ms.toFixed(0)} ms`);
    expect(r.ms).toBeLessThan(1000);
    expect(r.t.smallAsks.open.length).toBe(40);
    // Each ask is in one place: an ask row, a comment row, or behind a blocker.
    const placed = [
      ...r.t.yourMove.flatMap((x) => (x.kind === "thread" ? [] : [x.issue.key])),
      ...r.t.theirMove.flatMap((x) => (x.kind === "blocked" ? [x.issue.key] : [])),
    ];
    for (const a of r.t.smallAsks.open) expect(placed).toContain(a.issue.key);
    expect(new Set(placed).size).toBe(placed.length);
  }, 60_000);
});

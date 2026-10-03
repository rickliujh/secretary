/**
 * FR-3.8 acceptance over real HTTP (Phase 12 checklist): a "blocked by" link is
 * created on approval, the blocker closes in the mock, the next sync wakes the
 * ticket and one reminder is due; a reopened blocker puts it back to sleep. The
 * direction check runs against a mock that stores links reversed, and the same
 * flow runs in the Cloud shape. Real JiraClient, Sync, Executor and Proposals
 * against scripts/mock-jira.ts.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { inboxItems, intakeItems, issueMeta, proposals } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { loadDashboardInputs } from "@/services/dashboard/data";
import { buildDashboard } from "@/services/dashboard/sections";
import { query } from "@/services/db";
import { ExecutorLive } from "@/services/executor/live";
import { Proposals } from "@/services/proposals";
import { ProposalsLive } from "@/services/proposals/live";
import { DEFAULT_WEIGHTS } from "@/services/settings/schema";
import { groupSmallAsks, trackOrder } from "@/services/small-asks/bundle";
import { Sync } from "@/services/sync";
import { SyncLive } from "@/services/sync/live";
import { getState, SYNC_KEYS } from "@/services/sync/state";
import { jiraSettings, jiraTestLayer } from "@/test/layers";
import { createHandler, generate, type MockOptions } from "../../../scripts/mock-jira";
import { parseBlockers, parseLinkTypes } from "./logic";
import { dueUnblockNotifications, loadWokenTickets, markUnblockNotified } from "./queries";

const servers: { stop: (force?: boolean) => void }[] = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

const ME = { name: "me", displayName: "Me Myself", emailAddress: "me@example.com" };

function setup(opts: MockOptions = {}) {
  const issues = generate(40);
  const open = [...issues.values()].filter(
    (i) => i.project === "PAY" && i.type === "Story" && i.links.length === 0,
  );
  const target = open[0];
  const blocker = open[1];
  if (!target || !blocker) throw new Error("fixture");
  target.assignee = ME;
  target.status = "In Progress";
  blocker.status = "To Do";
  const handler = createHandler(issues, opts);
  const server = Bun.serve({ port: 0, fetch: handler });
  servers.push(server);
  const requests: { method: string; path: string; body: string }[] = [];
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    requests.push({
      method: req.method,
      path: new URL(req.url).pathname,
      body: req.body ? await req.clone().text() : "",
    });
    return fetch(req);
  };
  const base = jiraSettings({
    baseUrl: `http://localhost:${server.port}`,
    trackedEpics: [],
    ...(opts.cloud ? { deployment: "cloud" as const, email: "me@example.com" } : {}),
  });
  const layer = Layer.provideMerge(
    ProposalsLive,
    Layer.provideMerge(ExecutorLive, Layer.provideMerge(SyncLive, jiraTestLayer(fetchFn, base))),
  );
  return { issues, handler, target, blocker, requests, layer };
}

/** Stores a pending link_issues proposal and approves it, as Track or Approve would. */
const approveLink = (target: string, blocker: string) =>
  Effect.gen(function* () {
    const inboxItemId = newId();
    const id = newId();
    yield* query((d) =>
      d.insert(inboxItems).values({
        id: inboxItemId,
        source: "typed",
        rawText: `do ${target} once ${blocker} is done`,
        receivedAt: nowIso(),
      }),
    );
    yield* query((d) =>
      d.insert(proposals).values({
        id,
        inboxItemId,
        seq: 0,
        kind: "link_issues",
        payload: { kind: "link_issues", target, blocker },
        status: "pending",
        createdAt: nowIso(),
      }),
    );
    return yield* (yield* Proposals).approve(id);
  });

const meta = (key: string) =>
  query((d) => d.select().from(issueMeta).where(eq(issueMeta.issueKey, key)).get());

describe("blocked-by links and wake-up against the mock Jira (FR-3.8 AC)", () => {
  test("link created, blocker closed, next sync wakes the ticket and one reminder is due; reopening clears it", async () => {
    const { handler, target, blocker, requests, layer } = setup();
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sync = yield* Sync;
          yield* sync.run();
          const linkTypes = parseLinkTypes(yield* getState(SYNC_KEYS.linkTypes));
          const result = yield* approveLink(target.key, blocker.key);
          yield* sync.run();
          const asleep = yield* meta(target.key);

          // The blocker closes, but the scope query does not return it (an issue
          // outside the sync scope, here one whose `updated` is old): only the
          // blocker step can see the change.
          blocker.status = "Done";
          blocker.updated = "2026-07-01T09:00:00.000+0000";
          const searchesBefore = requests.length;
          yield* sync.run();
          const keyIn = requests
            .slice(searchesBefore)
            .find((x) => x.body.includes(`"key in (${blocker.key})"`));
          const woken = yield* meta(target.key);
          const due = yield* dueUnblockNotifications();
          const map = parseBlockers(yield* getState(SYNC_KEYS.blockers));
          const dashboard = buildDashboard(
            yield* loadDashboardInputs(),
            DEFAULT_WEIGHTS,
            "2026-10-03",
            nowIso(),
          );
          yield* markUnblockNotified(
            due.map((t) => t.key),
            nowIso(),
          );
          const dueAfter = yield* dueUnblockNotifications();
          const stillListed = yield* loadWokenTickets();

          // The blocker reopens.
          blocker.status = "In Progress";
          yield* sync.run();
          const reopened = yield* meta(target.key);
          return {
            linkTypes,
            result,
            asleep,
            keyIn,
            woken,
            due,
            map,
            dashboard,
            dueAfter,
            stillListed,
            reopened,
          };
        }),
        layer,
      ),
    );
    expect(r.linkTypes.blocks?.name).toBe("Blocks");
    expect(r.result).toMatchObject({
      status: "executed",
      message: `${target.key} is now blocked by ${blocker.key}`,
      issueKey: target.key,
    });
    expect(handler.links.filter((l) => l.to === target.key)).toEqual([
      expect.objectContaining({ from: blocker.key, to: target.key }),
    ]);
    // One POST and no delete: the mock keeps the direction the client asked for.
    expect(requests.filter((x) => x.path.endsWith("/issueLink")).map((x) => x.method)).toEqual([
      "POST",
    ]);
    expect(r.asleep).toMatchObject({ openBlockers: [blocker.key], unblockedAt: null });

    expect(r.keyIn).toBeDefined();
    expect(r.map[blocker.key]).toMatchObject({ status: "Done", statusCategory: "done" });
    expect(r.woken?.openBlockers).toEqual([]);
    expect(r.woken?.unblockedAt).not.toBeNull();
    expect(r.woken?.unblockedBy).toBe(blocker.key);
    expect(r.due.map((t) => t.key)).toEqual([target.key]);
    expect(r.due[0]?.reason).toMatch(new RegExp(`^${blocker.key} moved to Done`));
    // Ranking reads the fresh state: the target is no longer at risk as blocked.
    const atRisk = r.dashboard.atRisk.find((a) => a.issue.key === target.key);
    expect(atRisk?.reasons.some((x) => x.startsWith("Blocked by"))).not.toBe(true);
    // One notification per ticket: once sent, nothing is due, but it stays on Today.
    expect(r.dueAfter).toEqual([]);
    expect(r.stillListed.map((t) => [t.key, t.notified])).toEqual([[target.key, true]]);

    expect(r.reopened).toMatchObject({
      openBlockers: [blocker.key],
      unblockedAt: null,
      unblockedBy: null,
      unblockNotifiedAt: null,
    });
  });

  test("an instance that stores the link reversed: the Executor deletes it and posts it swapped", async () => {
    const { handler, target, blocker, requests, layer } = setup({ reversedLinks: true });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* (yield* Sync).run();
          return yield* approveLink(target.key, blocker.key);
        }),
        layer,
      ),
    );
    expect(r).toMatchObject({
      status: "executed",
      message: `${target.key} is now blocked by ${blocker.key}`,
    });
    expect(r.warning).toBeUndefined();
    const linkCalls = requests.filter((x) => /\/issueLink(\/\d+)?$/.test(x.path));
    expect(linkCalls.map((x) => x.method)).toEqual(["POST", "DELETE", "POST"]);
    const [first, , second] = linkCalls.map((x) => (x.body ? JSON.parse(x.body) : null));
    expect(first).toMatchObject({
      inwardIssue: { key: blocker.key },
      outwardIssue: { key: target.key },
    });
    expect(second).toMatchObject({
      inwardIssue: { key: target.key },
      outwardIssue: { key: blocker.key },
    });
    // What remains reads "target is blocked by blocker", once.
    const between = handler.links.filter(
      (l) => [l.from, l.to].includes(target.key) && [l.from, l.to].includes(blocker.key),
    );
    expect(between).toEqual([expect.objectContaining({ from: blocker.key, to: target.key })]);
  });

  test("approving again when Jira already shows the link writes nothing", async () => {
    const { requests, target, blocker, layer } = setup();
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* (yield* Sync).run();
          yield* approveLink(target.key, blocker.key);
          return yield* approveLink(target.key, blocker.key);
        }),
        layer,
      ),
    );
    expect(r).toMatchObject({
      status: "executed",
      message: `${target.key} is already blocked by ${blocker.key}`,
    });
    expect(requests.filter((x) => x.path.endsWith("/issueLink"))).toHaveLength(1);
  });

  test("Track on a small ask that waits for a ticket creates it, then the link to the new key", async () => {
    const { handler, issues, blocker, layer } = setup();
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* (yield* Sync).run();
          const inboxItemId = newId();
          const intakeItemId = newId();
          yield* query((d) =>
            d.insert(inboxItems).values({
              id: inboxItemId,
              source: "typed",
              rawText: `once ${blocker.key} is done tell the vendor`,
              receivedAt: nowIso(),
            }),
          );
          const row = (seq: number, payload: Record<string, unknown>) => ({
            id: newId(),
            inboxItemId,
            intakeItemId,
            seq,
            kind: String(payload.kind),
            payload,
            status: "pending" as const,
            createdAt: nowIso(),
          });
          const rows = [
            row(0, {
              kind: "create_issue",
              ref: "$new:1",
              projectKey: "PAY",
              issueType: "Task",
              summary: "Tell the vendor",
              assignee: "me",
              labels: ["small-ask"],
              smallAsk: true,
            }),
            row(1, { kind: "link_issues", target: "$new:1", blocker: blocker.key }),
          ];
          // The intake item the rows belong to (the bundle groups by it).
          yield* query((d) =>
            d.insert(intakeItems).values({
              id: intakeItemId,
              inboxItemId,
              idx: 0,
              quote: "q",
              snapshot: {},
              promptVersion: 8,
            }),
          );
          yield* query((d) => d.insert(proposals).values(rows));
          const entries = groupSmallAsks(rows.map((x) => ({ ...x, editedPayload: null })));
          const track = entries[0];
          if (entries.length !== 1 || track?.type !== "track") throw new Error("expected one row");
          return yield* (yield* Proposals).track(trackOrder(track.create, track.members));
        }),
        layer,
      ),
    );
    expect(r.map((x) => x.status)).toEqual(["executed", "executed"]);
    const key = r[0]?.issueKey ?? "";
    expect(issues.get(key)?.summary).toBe("Tell the vendor");
    expect(r[1]?.message).toBe(`${key} is now blocked by ${blocker.key}`);
    expect(handler.links.some((l) => l.from === blocker.key && l.to === key)).toBe(true);
  });

  test("the Cloud shape: Basic auth, search/jql, the same link and wake-up", async () => {
    const { handler, target, blocker, requests, layer } = setup({ cloud: true });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sync = yield* Sync;
          yield* sync.run();
          const result = yield* approveLink(target.key, blocker.key);
          yield* sync.run();
          blocker.status = "Done";
          yield* sync.run();
          return { result, woken: yield* loadWokenTickets() };
        }),
        layer,
      ),
    );
    expect(r.result.status).toBe("executed");
    expect(handler.links.some((l) => l.from === blocker.key && l.to === target.key)).toBe(true);
    expect(requests.some((x) => x.path.endsWith("/search/jql"))).toBe(true);
    expect(requests.some((x) => x.path.endsWith("/rest/api/2/search"))).toBe(false);
    expect(r.woken.map((t) => t.key)).toEqual([target.key]);
  });
});

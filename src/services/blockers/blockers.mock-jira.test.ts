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
import { inboxItems, intakeItems, issueMeta, jiraIssues, proposals } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { loadDashboardInputs } from "@/services/dashboard/data";
import { rankWork } from "@/services/dashboard/sections";
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
import {
  dueUnblockNotifications,
  loadWokenTickets,
  markUnblockNotified,
  silenceUnblockNotifications,
} from "./queries";

const servers: { stop: (force?: boolean) => void }[] = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

const ME = { name: "me", displayName: "Me Myself", emailAddress: "me@example.com" };

type Req = { method: string; path: string; body: string };
type Issues = ReturnType<typeof generate>;
type Fixture = { issues: Issues; target: Story; blocker: Story; open: Story[] };
type Story = NonNullable<ReturnType<Issues["get"]>>;

function setup(
  opts: MockOptions & {
    /** Runs before the mock reads the issues, to seed links. */
    seed?: (f: Fixture) => void;
    /** A response in place of the mock's (to fail a request), or undefined to pass it on. */
    intercept?: (r: Req) => Response | undefined;
  } = {},
) {
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
  opts.seed?.({ issues, target, blocker, open });
  const handler = createHandler(issues, opts);
  const server = Bun.serve({ port: 0, fetch: handler });
  servers.push(server);
  const requests: Req[] = [];
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const r = {
      method: req.method,
      path: new URL(req.url).pathname,
      body: req.body ? await req.clone().text() : "",
    };
    requests.push(r);
    return opts.intercept?.(r) ?? fetch(req);
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
  return { issues, handler, target, blocker, open, requests, layer };
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
          const dashboard = rankWork(
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

/** Before the generated issues' times, so an incremental sync does not return the issue. */
const OLD = "2026-07-01T09:00:00.000+0000";
const now = () => new Date().toISOString().replace("Z", "+0000");
const blockedBy = (issue: Story, key: string) => issue.links.push({ type: "Blocks", inward: key });
const keyInSearches = (requests: readonly Req[], from = 0) =>
  requests.slice(from).filter((r) => r.method === "POST" && r.body.includes('"key in ('));
const issueGets = (requests: readonly Req[], key: string, from = 0) =>
  requests.slice(from).filter((r) => r.method === "GET" && r.path.endsWith(`/issue/${key}`));
const blockerMap = Effect.map(getState(SYNC_KEYS.blockers), parseBlockers);
const between = (links: readonly { from: string; to: string }[], a: string, b: string) =>
  links.filter((l) => [l.from, l.to].includes(a) && [l.from, l.to].includes(b));
/** Not returned by the next incremental sync. */
const age = (...issues: Story[]) => {
  for (const i of issues) i.updated = OLD;
};

describe("linking safely (D45 review)", () => {
  test("a target that already blocks the blocker is refused, and the user's link stays", async () => {
    const { handler, target, blocker, requests, layer } = setup({
      reversedLinks: true,
      // The user's own link: target blocks blocker.
      seed: ({ target, blocker }) => blockedBy(blocker, target.key),
    });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* (yield* Sync).run();
          return yield* approveLink(target.key, blocker.key);
        }),
        layer,
      ),
    );
    expect(r.status).toBe("failed");
    expect(r.message).toContain(`${target.key} already blocks ${blocker.key} in Jira`);
    expect(requests.filter((x) => /\/issueLink(\/\d+)?$/.test(x.path))).toEqual([]);
    expect(between(handler.links, target.key, blocker.key)).toEqual([
      expect.objectContaining({ from: target.key, to: blocker.key }),
    ]);
  });

  test("a swap whose second POST fails says the link was removed; Retry links again", async () => {
    let posts = 0;
    const { handler, target, blocker, layer } = setup({
      reversedLinks: true,
      intercept: (r) =>
        r.method === "POST" && r.path.endsWith("/issueLink") && ++posts === 2
          ? Response.json({ errorMessages: ["Something broke"], errors: {} }, { status: 500 })
          : undefined,
    });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* (yield* Sync).run();
          const first = yield* approveLink(target.key, blocker.key);
          const linksAfterFailure = between(handler.links, target.key, blocker.key).length;
          const failed = yield* query((d) =>
            d
              .select({ id: proposals.id })
              .from(proposals)
              .where(eq(proposals.status, "failed"))
              .get(),
          );
          const retry = failed ? yield* (yield* Proposals).approve(failed.id) : null;
          return { first, linksAfterFailure, retry };
        }),
        layer,
      ),
    );
    expect(r.first.status).toBe("failed");
    expect(r.first.message).toContain(
      `${target.key} and ${blocker.key} are not linked now: Jira stored the link the wrong way round, so it was removed`,
    );
    expect(r.first.message).toContain("Retry links them again.");
    expect(r.linksAfterFailure).toBe(0);
    expect(r.retry).toMatchObject({ status: "executed" });
    expect(between(handler.links, target.key, blocker.key)).toEqual([
      expect.objectContaining({ from: blocker.key, to: target.key }),
    ]);
  });
});

describe("reading blockers after sync (D45 review)", () => {
  test("a failed read keeps the last known state and wakes nothing; the next good read does", async () => {
    let failing = false;
    const { target, blocker, requests, layer } = setup({
      seed: ({ target, blocker }) => blockedBy(target, blocker.key),
      intercept: (r) =>
        failing &&
        (r.body.includes('"key in (') ||
          (r.method === "GET" && r.path.endsWith(`/issue/${blocker.key}`)))
          ? new Response("busy", { status: 500 })
          : undefined,
    });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sync = yield* Sync;
          yield* sync.run();
          const before = yield* blockerMap;
          // The blocker closes; the target is fetched again, so its link embeds "Done".
          blocker.status = "Done";
          age(blocker);
          target.updated = now();
          failing = true;
          const mark = requests.length;
          yield* sync.run();
          const tried = keyInSearches(requests, mark).length;
          const during = { meta: yield* meta(target.key), map: yield* blockerMap };
          failing = false;
          yield* sync.run();
          return { before, tried, during, after: yield* meta(target.key) };
        }),
        layer,
      ),
    );
    expect(r.before[blocker.key]?.statusCategory).not.toBe("done");
    expect(r.tried).toBeGreaterThan(0);
    // The stored state is the last one read, not what the target's link embeds.
    expect(r.during.map[blocker.key]).toEqual(r.before[blocker.key]);
    expect(r.during.meta).toMatchObject({ openBlockers: [blocker.key], unblockedAt: null });
    expect(r.after?.unblockedAt).not.toBeNull();
    expect(r.after?.unblockedBy).toBe(blocker.key);
  });

  test("Cloud: a deleted blocker fails the search; halves are retried, the 404 is gone and remembered", async () => {
    const { issues, target, blocker, open, requests, layer } = setup({
      cloud: true,
      seed: ({ target, blocker, open }) => {
        blockedBy(target, blocker.key);
        blockedBy(target, open[2]?.key ?? "");
      },
    });
    const deleted = open[2];
    if (!deleted) throw new Error("fixture");
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sync = yield* Sync;
          yield* sync.run();
          const asleep = yield* meta(target.key);
          issues.delete(deleted.key);
          blocker.status = "Done";
          age(target, blocker);
          const mark = requests.length;
          yield* sync.run();
          const second = requests.length;
          const woken = yield* meta(target.key);
          const map = yield* blockerMap;
          const listed = yield* loadWokenTickets();
          yield* sync.run();
          return { asleep, mark, second, woken, map, listed };
        }),
        layer,
      ),
    );
    expect(r.asleep?.openBlockers).toEqual([blocker.key, deleted.key].sort());
    // The two-key search failed, then each half was searched alone.
    const searched = keyInSearches(requests, r.mark)
      .slice(0, 3)
      .map((x) => JSON.parse(x.body).jql);
    expect(searched).toHaveLength(3);
    expect(searched).toContain(`key in (${blocker.key})`);
    expect(searched).toContain(`key in (${deleted.key})`);
    expect(issueGets(requests, deleted.key, r.mark)).toHaveLength(1);
    expect(r.map[deleted.key]).toMatchObject({ statusCategory: "done", gone: true });
    expect(r.map[blocker.key]).toMatchObject({ statusCategory: "done" });
    expect(r.woken?.unblockedAt).not.toBeNull();
    expect(r.woken?.openBlockers).toEqual([]);
    expect(r.listed.map((t) => t.key)).toEqual([target.key]);
    // Remembered: the next sync neither reads nor searches for it.
    expect(issueGets(requests, deleted.key, r.second)).toHaveLength(0);
    expect(keyInSearches(requests, r.second).some((x) => x.body.includes(deleted.key))).toBe(false);
  });

  test("a blocker the user may not read (403) does not wake the issue, even when its link says Done", async () => {
    const hidden = new Set<string>();
    const { target, blocker, requests, layer } = setup({
      hidden,
      seed: ({ target, blocker }) => blockedBy(target, blocker.key),
    });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sync = yield* Sync;
          yield* sync.run();
          hidden.add(blocker.key);
          blocker.status = "Done";
          age(blocker);
          target.updated = now();
          const mark = requests.length;
          yield* sync.run();
          const second = requests.length;
          const after = yield* meta(target.key);
          target.updated = now();
          yield* sync.run();
          return { mark, second, after, again: yield* meta(target.key) };
        }),
        layer,
      ),
    );
    expect(issueGets(requests, blocker.key, r.mark).length).toBeGreaterThan(0);
    expect(r.after).toMatchObject({ openBlockers: [blocker.key], unblockedAt: null });
    expect(r.again).toMatchObject({ openBlockers: [blocker.key], unblockedAt: null });
    // Not read again on the next sync.
    expect(issueGets(requests, blocker.key, r.second)).toHaveLength(0);
  });

  test("a moved blocker found under its new key is stored under the key the link names", async () => {
    const moved = new Map<string, string>();
    const { issues, target, blocker, layer } = setup({
      moved,
      seed: ({ target, blocker }) => blockedBy(target, blocker.key),
    });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sync = yield* Sync;
          yield* sync.run();
          issues.delete(blocker.key);
          issues.set("OPS-999", {
            ...blocker,
            key: "OPS-999",
            project: "OPS",
            status: "Done",
            updated: OLD,
          });
          moved.set(blocker.key, "OPS-999");
          age(target);
          yield* sync.run();
          return { map: yield* blockerMap, woken: yield* meta(target.key) };
        }),
        layer,
      ),
    );
    expect(r.map[blocker.key]).toMatchObject({ status: "Done", statusCategory: "done" });
    expect(r.woken?.unblockedAt).not.toBeNull();
  });

  test("Cloud: a search that returns fewer than asked is followed to its next page", async () => {
    const { target, blocker, open, requests, layer } = setup({
      cloud: true,
      searchPageSize: 1,
      seed: ({ target, blocker, open }) => {
        blockedBy(target, blocker.key);
        blockedBy(target, open[2]?.key ?? "");
      },
    });
    const second = open[2];
    if (!second) throw new Error("fixture");
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sync = yield* Sync;
          yield* sync.run();
          blocker.status = "Done";
          second.status = "Done";
          age(target, blocker, second);
          const mark = requests.length;
          yield* sync.run();
          return { mark, woken: yield* meta(target.key) };
        }),
        layer,
      ),
    );
    const pages = keyInSearches(requests, r.mark).map((x) => JSON.parse(x.body));
    expect(pages).toHaveLength(2);
    expect(pages[1]?.nextPageToken).toBeDefined();
    expect(issueGets(requests, blocker.key, r.mark)).toHaveLength(0);
    expect(issueGets(requests, second.key, r.mark)).toHaveLength(0);
    expect(r.woken?.unblockedAt).not.toBeNull();
  });
});

describe("wake state follows the user's issues (D45 review)", () => {
  test("a ticket reassigned away forgets its blockers, so on return it does not wake with an old reason", async () => {
    const { target, blocker, layer } = setup({
      seed: ({ target, blocker }) => blockedBy(target, blocker.key),
    });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sync = yield* Sync;
          yield* sync.run();
          const asleep = yield* meta(target.key);
          target.assignee = null;
          target.updated = now();
          yield* sync.run();
          const away = yield* meta(target.key);
          blocker.status = "Done";
          age(blocker);
          yield* sync.run();
          target.assignee = ME;
          target.updated = now();
          yield* sync.run();
          return { asleep, away, back: yield* meta(target.key) };
        }),
        layer,
      ),
    );
    expect(r.asleep?.openBlockers).toEqual([blocker.key]);
    expect(r.away).toMatchObject({ openBlockers: null, unblockedAt: null });
    expect(r.back).toMatchObject({ openBlockers: [], unblockedAt: null });
  });

  test("a woken ticket no longer assigned to the user leaves the list and is not notified", async () => {
    const { target, blocker, layer } = setup({
      seed: ({ target, blocker }) => blockedBy(target, blocker.key),
    });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sync = yield* Sync;
          yield* sync.run();
          blocker.status = "Done";
          age(target, blocker);
          yield* sync.run();
          const woken = yield* loadWokenTickets();
          // Reassigned in Jira and stored by a refresh, before the next sync.
          yield* query((d) =>
            d.update(jiraIssues).set({ assignee: "ana.b" }).where(eq(jiraIssues.key, target.key)),
          );
          return {
            woken,
            after: yield* loadWokenTickets(),
            due: yield* dueUnblockNotifications(),
          };
        }),
        layer,
      ),
    );
    expect(r.woken.map((t) => t.key)).toEqual([target.key]);
    expect(r.after).toEqual([]);
    expect(r.due).toEqual([]);
  });

  test("closing a blocker shows at once: the refresh after the write updates the map and wakes", async () => {
    const { target, blocker, layer } = setup({
      seed: ({ target, blocker }) => blockedBy(target, blocker.key),
    });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sync = yield* Sync;
          yield* sync.run();
          // What the Executor does after a write: re-fetch the issue it changed.
          blocker.status = "Done";
          yield* sync.refreshIssue(blocker.key);
          return { map: yield* blockerMap, woken: yield* meta(target.key) };
        }),
        layer,
      ),
    );
    expect(r.map[blocker.key]).toMatchObject({ status: "Done", statusCategory: "done" });
    expect(r.woken?.unblockedAt).not.toBeNull();
    expect(r.woken?.unblockedBy).toBe(blocker.key);
  });

  test("while reminders are off, wake-ups are marked without a notification, so none burst later", async () => {
    const { target, blocker, layer } = setup({
      seed: ({ target, blocker }) => blockedBy(target, blocker.key),
    });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sync = yield* Sync;
          yield* sync.run();
          blocker.status = "Done";
          age(target, blocker);
          yield* sync.run();
          const due = yield* dueUnblockNotifications();
          const silenced = yield* silenceUnblockNotifications();
          return {
            due,
            silenced,
            dueAfter: yield* dueUnblockNotifications(),
            listed: yield* loadWokenTickets(),
          };
        }),
        layer,
      ),
    );
    expect(r.due.map((t) => t.key)).toEqual([target.key]);
    expect(r.silenced).toEqual([target.key]);
    expect(r.dueAfter).toEqual([]);
    // Still first on Today.
    expect(r.listed.map((t) => t.key)).toEqual([target.key]);
  });
});

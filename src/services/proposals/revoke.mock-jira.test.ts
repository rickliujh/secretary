/**
 * FR-14 acceptance over real HTTP (Phase 17 checklist): a small ask tracked
 * with a wait and a comment, revoked as a user without the delete permission,
 * leaves the ticket cancelled with a comment, the Secretary comment deleted, the
 * wait gone and the row revoked; with the permission the ticket is gone. Then
 * each Jira kind, a field changed since, and a failed step that a second Revoke
 * finishes. Real JiraClient, Sync, Executor and Proposals against
 * scripts/mock-jira.ts.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import {
  actionsLog,
  dependencies,
  inboxItems,
  intakeItems,
  issueMeta,
  jiraIssues,
  proposals,
} from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { query } from "@/services/db";
import { mirror } from "@/services/dependencies/queries";
import { ExecutorLive } from "@/services/executor/live";
import { groupSmallAsks, trackOrder } from "@/services/small-asks/bundle";
import { Sync } from "@/services/sync";
import { SyncLive } from "@/services/sync/live";
import { jiraSettings, jiraTestLayer } from "@/test/layers";
import {
  boardSprints,
  createHandler,
  generate,
  type MockOptions,
} from "../../../scripts/mock-jira";
import { Proposals, type StoredProposalPayload } from ".";
import { ProposalsLive } from "./live";
import { REVOKE_COMMENT } from "./revoke";

const servers: { stop: (force?: boolean) => void }[] = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

type Req = { method: string; path: string };

function setup(opts: MockOptions & { intercept?: (r: Req) => Response | undefined } = {}) {
  const issues = generate(40);
  const stories = [...issues.values()].filter(
    (i) => i.project === "PAY" && i.type === "Story" && i.links.length === 0,
  );
  const [a, b] = stories;
  if (!a || !b) throw new Error("fixture");
  a.status = "To Do";
  a.priority = "Low";
  a.due = null;
  a.assignee = { name: "tom.k", displayName: "Tom Kay", emailAddress: "tom@example.com" };
  const server = Bun.serve({
    port: 0,
    fetch: createHandler(issues, { cancelStatus: true, ...opts }),
  });
  servers.push(server);
  const requests: Req[] = [];
  const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const r = { method: req.method, path: new URL(req.url).pathname };
    requests.push(r);
    return opts.intercept?.(r) ?? fetch(req);
  };
  const layer = Layer.provideMerge(
    ProposalsLive,
    Layer.provideMerge(
      ExecutorLive,
      Layer.provideMerge(
        SyncLive,
        jiraTestLayer(
          fetchFn,
          jiraSettings({ baseUrl: `http://localhost:${server.port}`, trackedEpics: [] }),
        ),
      ),
    ),
  );
  return { issues, a, b, layer, requests };
}

/** An inbox item with one intake item and these proposals, pending, in order. */
const seed = (payloads: StoredProposalPayload[]) =>
  Effect.gen(function* () {
    const inboxItemId = newId();
    const intakeItemId = newId();
    yield* query((d) =>
      d.insert(inboxItems).values({
        id: inboxItemId,
        source: "teams",
        rawText: "can you send me the Q3 numbers?",
        receivedAt: nowIso(),
        status: "triaged",
      }),
    );
    yield* query((d) =>
      d.insert(intakeItems).values({
        id: intakeItemId,
        inboxItemId,
        idx: 0,
        quote: "can you send me the Q3 numbers?",
        snapshot: {},
        promptVersion: 1,
      }),
    );
    const ids = payloads.map(() => newId());
    yield* query((d) =>
      d.insert(proposals).values(
        payloads.map((payload, seq) => ({
          id: ids[seq] ?? "",
          inboxItemId,
          intakeItemId,
          seq,
          kind: payload.kind,
          payload,
          status: "pending" as const,
          createdAt: nowIso(),
        })),
      ),
    );
    return { inboxItemId, ids };
  });

const SMALL_ASK: StoredProposalPayload[] = [
  {
    kind: "create_issue",
    ref: "$new:1",
    projectKey: "PAY",
    issueType: "Task",
    summary: "Send Dana the Q3 numbers",
    labels: ["small-ask"],
    assignee: "me",
    smallAsk: true,
  },
  {
    kind: "link_dependency",
    target: "$new:1",
    dependencyKind: "team",
    label: "Finance export of Q3 totals",
  },
  { kind: "add_comment", target: "$new:1", bodyMd: "Asked finance for the export." },
];

const statusOf = (id: string) =>
  Effect.map(
    query((d) =>
      d
        .select({ status: proposals.status, result: proposals.result })
        .from(proposals)
        .where(eq(proposals.id, id))
        .get(),
    ),
    (r) => ({ status: r?.status, result: r?.result as Record<string, unknown> | null }),
  );

/** Tracks the small ask (create and wait), then approves the comment card under it. */
const trackSmallAsk = Effect.gen(function* () {
  yield* (yield* Sync).run();
  const { ids } = yield* seed(SMALL_ASK);
  const rows = yield* query((d) => d.select().from(proposals).all());
  const row = groupSmallAsks(rows)[0];
  if (row?.type !== "track") throw new Error("expected a Track row");
  const svc = yield* Proposals;
  const tracked = yield* svc.track(trackOrder(row.create, row.members));
  const comment = yield* svc.approve(ids[2] ?? "");
  const key = tracked[0]?.issueKey ?? "";
  return { ids, key, statuses: [...tracked, comment].map((r) => r.status) };
});

describe("revoking a tracked small ask (FR-14 AC)", () => {
  test("without delete permission: cancelled with a comment, our comment and the wait gone, rows revoked", async () => {
    const { issues, layer } = setup({ canDelete: false });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const t = yield* trackSmallAsk;
          const commentsBefore = issues.get(t.key)?.comments.map((c) => c.body) ?? [];
          const svc = yield* Proposals;
          const plan = yield* svc.revokePlan(t.ids[0] ?? "");
          const steps = plan.entries.flatMap((e) => e.steps.map((s) => s.text));
          const result = yield* svc.revoke(t.ids[0] ?? "", steps);
          return {
            ...t,
            commentsBefore,
            plan,
            steps,
            result,
            rows: yield* Effect.all(t.ids.map(statusOf)),
            waits: yield* query((d) => d.select().from(dependencies).all()),
            cached: yield* query((d) =>
              d.select().from(jiraIssues).where(eq(jiraIssues.key, t.key)).get(),
            ),
          };
        }),
        layer,
      ),
    );
    expect(r.statuses).toEqual(["executed", "executed", "executed"]);
    expect(r.commentsBefore).toEqual(["Asked finance for the export."]);
    // The confirmation lists every step: what acts on the ticket first, newest first.
    expect(r.steps).toEqual([
      `Delete the comment on ${r.key}`,
      "Delete the wait on Finance export of Q3 totals",
      `Comment on ${r.key}: "${REVOKE_COMMENT}"`,
      `Move ${r.key} to Cancelled`,
    ]);
    expect(r.plan.entries.at(-1)?.notes[0]).toContain("may not delete");
    expect(r.result.status).toBe("revoked");
    const ticket = issues.get(r.key);
    expect(ticket?.status).toBe("Cancelled");
    expect(ticket?.comments.map((c) => c.body)).toEqual([REVOKE_COMMENT]);
    expect(r.waits).toEqual([]);
    expect(r.rows.map((x) => x.status)).toEqual(["revoked", "revoked", "revoked"]);
    // The result keeps what the approval did and says what the revoke did.
    expect(r.rows[0]?.result).toMatchObject({
      issueKey: r.key,
      revoked: { message: `Commented on ${r.key}; Moved ${r.key} to Cancelled` },
    });
    // The cache shows Jira's version.
    expect(r.cached?.status).toBe("Cancelled");
  });

  test("with delete permission the ticket is gone, from Jira and the cache", async () => {
    const { issues, layer } = setup();
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const t = yield* trackSmallAsk;
          yield* query((d) =>
            d.insert(issueMeta).values({ issueKey: t.key, pinned: true }).onConflictDoNothing(),
          );
          const result = yield* (yield* Proposals).revoke(t.ids[0] ?? "");
          return {
            ...t,
            result,
            rows: yield* Effect.all(t.ids.map(statusOf)),
            waits: yield* query((d) => d.select().from(dependencies).all()),
            cached: yield* query((d) =>
              d.select().from(jiraIssues).where(eq(jiraIssues.key, t.key)).get(),
            ),
            meta: yield* query((d) =>
              d.select().from(issueMeta).where(eq(issueMeta.issueKey, t.key)).get(),
            ),
          };
        }),
        layer,
      ),
    );
    expect(r.result).toMatchObject({ status: "revoked" });
    expect(r.result.undone).toEqual([
      `Deleted the comment on ${r.key}`,
      "Deleted the wait on Finance export of Q3 totals",
      `Deleted ${r.key}`,
    ]);
    expect(issues.has(r.key)).toBe(false);
    expect(r.cached).toBeUndefined();
    expect(r.meta).toBeUndefined();
    expect(r.waits).toEqual([]);
    expect(r.rows.map((x) => x.status)).toEqual(["revoked", "revoked", "revoked"]);
  });

  test("a failed step stops the revoke and says what was undone; Revoke again finishes", async () => {
    let failMove = true;
    const { issues, layer, requests } = setup({
      canDelete: false,
      intercept: (r) => {
        if (failMove && r.method === "POST" && r.path.endsWith("/transitions")) {
          failMove = false;
          return new Response(JSON.stringify({ errorMessages: ["Workflow is busy."] }), {
            status: 500,
            headers: { "content-type": "application/json" },
          });
        }
        return undefined;
      },
    });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const t = yield* trackSmallAsk;
          const svc = yield* Proposals;
          const first = yield* svc.revoke(t.ids[0] ?? "");
          const between = yield* Effect.all(t.ids.map(statusOf));
          const second = yield* svc.revoke(t.ids[0] ?? "");
          return { ...t, first, between, second, after: yield* Effect.all(t.ids.map(statusOf)) };
        }),
        layer,
      ),
    );
    expect(r.first.status).toBe("failed");
    expect(r.first.message).toContain(`Move ${r.key} to Cancelled failed`);
    expect(r.first.message).toContain("Revoke again to finish");
    expect(r.first.undone).toEqual([
      `Deleted the comment on ${r.key}`,
      "Deleted the wait on Finance export of Q3 totals",
      `Commented on ${r.key}`,
    ]);
    // What hung on the ticket is revoked; the ticket's own proposal stays executed with the error.
    expect(r.between.map((x) => x.status)).toEqual(["executed", "revoked", "revoked"]);
    expect(r.between[0]?.result?.revokeError).toMatchObject({ undone: r.first.undone });
    // The second press only moves it: the comment is not posted twice.
    expect(r.second).toMatchObject({ status: "revoked", undone: [`Moved ${r.key} to Cancelled`] });
    expect(issues.get(r.key)?.comments.map((c) => c.body)).toEqual([REVOKE_COMMENT]);
    expect(issues.get(r.key)?.status).toBe("Cancelled");
    expect(r.after[0]?.status).toBe("revoked");
    expect(r.after[0]?.result?.revokeError).toBeUndefined();
    expect(requests.filter((x) => x.method === "POST" && x.path.endsWith("/comment"))).toHaveLength(
      2,
    );
  });
});

describe("revoking each Jira kind (mock Jira)", () => {
  const approveAndRevoke = (
    layer: ReturnType<typeof setup>["layer"],
    payload: StoredProposalPayload,
    between?: Effect.Effect<unknown, unknown, never>,
  ) =>
    Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* (yield* Sync).run();
          const { ids } = yield* seed([payload]);
          const id = ids[0] ?? "";
          const svc = yield* Proposals;
          const approved = yield* svc.approve(id);
          if (between) yield* between;
          const result = yield* svc.revoke(id);
          return { approved, result, row: yield* statusOf(id) };
        }),
        layer,
      ) as Effect.Effect<
        {
          approved: { status: string };
          result: { status: string; warning?: string; undone: string[] };
          row: { status?: string };
        },
        unknown,
        never
      >,
    );

  test("update_issue puts the values back; a field changed since stays, with a warning", async () => {
    const { a, layer } = setup();
    const r = await approveAndRevoke(
      layer,
      { kind: "update_issue", target: a.key, changes: { priority: "High", dueDate: "2026-10-30" } },
      // Someone changes the priority in Jira after the approval.
      Effect.sync(() => {
        a.priority = "Highest";
      }),
    );
    expect(r.approved.status).toBe("executed");
    expect(r.result.status).toBe("revoked");
    expect(a.due).toBeNull();
    expect(a.priority).toBe("Highest");
    expect(r.result.warning).toBe(
      `The priority of ${a.key} was changed since (now Highest), so it stays as it is.`,
    );
    expect(r.row.status).toBe("revoked");
  });

  test("update_issue puts the assignee back", async () => {
    const { a, layer } = setup();
    const r = await approveAndRevoke(layer, {
      kind: "update_issue",
      target: a.key,
      changes: { assignee: "me" },
    });
    // Named as Jira shows the user, not by user id.
    expect(r.result.undone).toEqual([`Assigned ${a.key} back to Tom Kay`]);
    expect(a.assignee?.name).toBe("tom.k");
  });

  test("transition_issue moves it back", async () => {
    const { a, layer } = setup();
    const r = await approveAndRevoke(layer, {
      kind: "transition_issue",
      target: a.key,
      toStatus: "In Progress",
    });
    expect(r.result.undone).toEqual([`Moved ${a.key} back to To Do`]);
    expect(a.status).toBe("To Do");
  });

  test("move_to_sprint moves it back to the backlog", async () => {
    const { a, layer } = setup();
    const active = boardSprints(1).find((s) => s.state === "active");
    if (!active) throw new Error("fixture");
    a.inBacklog = true;
    const r = await approveAndRevoke(layer, {
      kind: "move_to_sprint",
      target: a.key,
      sprintId: active.id,
      sprintName: active.name,
    });
    expect(r.approved.status).toBe("executed");
    expect(r.result.undone).toEqual([`Moved ${a.key} back to the backlog`]);
    expect(a.inBacklog).toBe(true);
    expect(a.movedToSprint).toBeUndefined();
  });

  test("link_issues removes the link it made", async () => {
    const { a, b, layer, requests } = setup();
    const r = await approveAndRevoke(layer, { kind: "link_issues", target: a.key, blocker: b.key });
    expect(r.result.undone).toEqual([`Removed the link "${a.key} is blocked by ${b.key}"`]);
    expect(
      requests.filter((x) => x.method === "DELETE" && x.path.includes("/issueLink/")),
    ).toHaveLength(1);
  });

  test("add_comment deletes the comment", async () => {
    const { a, layer } = setup();
    const before = a.comments.length;
    const r = await approveAndRevoke(layer, { kind: "add_comment", target: a.key, bodyMd: "Hi" });
    expect(r.result.undone).toEqual([`Deleted the comment on ${a.key}`]);
    expect(a.comments).toHaveLength(before);
  });
});

/** Runs a program against the mock's layer. */
const inMock = <A>(
  layer: ReturnType<typeof setup>["layer"],
  program: Effect.Effect<A, unknown, Layer.Layer.Success<ReturnType<typeof setup>["layer"]>>,
) => Effect.runPromise(Effect.provide(program, layer) as Effect.Effect<A, unknown, never>);

const TICKET: StoredProposalPayload = {
  kind: "create_issue",
  ref: "$new:1",
  projectKey: "PAY",
  issueType: "Task",
  summary: "Send Dana the Q3 numbers",
};

/** Seeds a thread, approves each proposal in order, and returns the ids and the new key. */
const approveThread = (payloads: StoredProposalPayload[]) =>
  Effect.gen(function* () {
    yield* (yield* Sync).run();
    const seeded = yield* seed(payloads);
    const svc = yield* Proposals;
    const results = [];
    for (const id of seeded.ids) results.push(yield* svc.approve(id));
    return { ...seeded, results, key: results[0]?.issueKey ?? "" };
  });

/** The step texts the confirmation shows, confirmed as they are. */
const confirmAndRevoke = (id: string) =>
  Effect.gen(function* () {
    const svc = yield* Proposals;
    const plan = yield* svc.revokePlan(id);
    const steps = plan.entries.flatMap((e) => e.steps.map((x) => x.text));
    return { plan, steps, result: yield* svc.revoke(id, steps) };
  });

describe("a cascade planned end to end (mock Jira workflow)", () => {
  test("a ticket moved to Done in a later turn is moved back, then closed as cancelled", async () => {
    const { issues, layer } = setup({ canDelete: false });
    const r = await inMock(
      layer,
      Effect.gen(function* () {
        const t = yield* approveThread([
          TICKET,
          { kind: "transition_issue", target: "$new:1", toStatus: "Done" },
        ]);
        const doneBefore = issues.get(t.key)?.status;
        const revoked = yield* confirmAndRevoke(t.ids[0] ?? "");
        return { ...t, doneBefore, ...revoked, rows: yield* Effect.all(t.ids.map(statusOf)) };
      }),
    );
    expect(r.results.map((x) => x.status)).toEqual(["executed", "executed"]);
    expect(r.doneBefore).toBe("Done");
    expect(r.steps).toEqual([
      `Move ${r.key} back to To Do`,
      `Comment on ${r.key}: "${REVOKE_COMMENT}"`,
      `Move ${r.key} to Cancelled`,
    ]);
    expect(r.result.status).toBe("revoked");
    // From Done the mock workflow only reopens; the cancel move is chosen from To Do.
    expect(issues.get(r.key)?.status).toBe("Cancelled");
    expect(r.rows.map((x) => x.status)).toEqual(["revoked", "revoked"]);
  });

  test("two moves of the new ticket go back in turn before it is deleted", async () => {
    const { issues, layer, requests } = setup();
    const r = await inMock(
      layer,
      Effect.gen(function* () {
        const t = yield* approveThread([
          TICKET,
          { kind: "transition_issue", target: "$new:1", toStatus: "In Progress" },
          { kind: "transition_issue", target: "$new:1", toStatus: "In Review" },
        ]);
        const history = () => issues.get(t.key)?.status;
        const before = history();
        const revoked = yield* confirmAndRevoke(t.ids[0] ?? "");
        return { ...t, before, ...revoked };
      }),
    );
    expect(r.before).toBe("In Review");
    expect(r.steps).toEqual([
      `Move ${r.key} back to In Progress`,
      `Move ${r.key} back to To Do`,
      `Delete ${r.key} in Jira`,
    ]);
    expect(r.result).toMatchObject({ status: "revoked" });
    expect(r.result.warning).toBeUndefined();
    expect(issues.has(r.key)).toBe(false);
    // Each move was posted from the status it starts in: none refused.
    expect(
      requests.filter((x) => x.method === "POST" && x.path.endsWith(`${r.key}/transitions`)),
    ).toHaveLength(4);
  });

  test("two changes of one field end at the value before the first", async () => {
    const { a, layer } = setup();
    const r = await inMock(
      layer,
      Effect.gen(function* () {
        const t = yield* approveThread([
          TICKET,
          { kind: "update_issue", target: "$new:1", changes: { priority: "High" } },
          { kind: "update_issue", target: "$new:1", changes: { priority: "Highest" } },
        ]);
        return { ...t, ...(yield* confirmAndRevoke(t.ids[0] ?? "")) };
      }),
    );
    void a;
    expect(r.steps).toEqual([
      `Set the priority back to High on ${r.key}`,
      `Set the priority back to Medium on ${r.key}`,
      `Delete ${r.key} in Jira`,
    ]);
    expect(r.result.warning).toBeUndefined();
  });

  test("a sub-task made under the ticket is deleted first, so the ticket is deleted too", async () => {
    const { issues, layer } = setup();
    const r = await inMock(
      layer,
      Effect.gen(function* () {
        const t = yield* approveThread([
          TICKET,
          {
            kind: "create_issue",
            ref: "$new:2",
            projectKey: "PAY",
            issueType: "Sub-task",
            summary: "Ask finance",
            parent: "$new:1",
          },
        ]);
        const sub = t.results[1]?.issueKey ?? "";
        return { ...t, sub, ...(yield* confirmAndRevoke(t.ids[0] ?? "")) };
      }),
    );
    expect(r.steps).toEqual([`Delete ${r.sub} in Jira`, `Delete ${r.key} in Jira`]);
    expect(r.result.status).toBe("revoked");
    expect(issues.has(r.sub)).toBe(false);
    expect(issues.has(r.key)).toBe(false);
  });
});

describe("steps Jira refuses when they run", () => {
  test("a delete Jira refuses although permitted closes the ticket instead, with a warning", async () => {
    const undeletable = new Set<string>();
    const { issues, layer } = setup({ undeletable });
    const r = await inMock(
      layer,
      Effect.gen(function* () {
        const t = yield* approveThread([TICKET]);
        undeletable.add(t.key);
        return { ...t, ...(yield* confirmAndRevoke(t.ids[0] ?? "")) };
      }),
    );
    expect(r.steps).toEqual([`Delete ${r.key} in Jira`]);
    expect(r.result.status).toBe("revoked");
    expect(r.result.undone).toEqual([`Commented on ${r.key}`, `Moved ${r.key} to Cancelled`]);
    expect(r.result.warning).toContain(`${r.key} could not be deleted (Jira refused:`);
    expect(r.result.warning).toContain("so it was closed instead.");
    expect(issues.get(r.key)?.status).toBe("Cancelled");
    expect(issues.get(r.key)?.comments.map((c) => c.body)).toEqual([REVOKE_COMMENT]);
  });

  test("an assignee Jira will not take back is a warning, not a failure", async () => {
    const unassignable = new Set<string>();
    const { a, layer } = setup({ unassignable });
    const r = await inMock(
      layer,
      Effect.gen(function* () {
        const t = yield* approveThread([
          { kind: "update_issue", target: a.key, changes: { priority: "High", assignee: "me" } },
        ]);
        unassignable.add("tom.k");
        return {
          ...t,
          ...(yield* confirmAndRevoke(t.ids[0] ?? "")),
          row: yield* statusOf(t.ids[0] ?? ""),
        };
      }),
    );
    expect(r.steps).toEqual([
      `Set the priority back to Low on ${a.key}`,
      `Assign ${a.key} back to Tom Kay`,
    ]);
    expect(r.result.status).toBe("revoked");
    expect(r.result.undone).toEqual([`Set the priority back to Low on ${a.key}`]);
    expect(r.result.warning).toContain(`Jira refused to assign ${a.key} back to Tom Kay`);
    expect(a.priority).toBe("Low");
    expect(a.assignee?.name).toBe("me");
    expect(r.row.status).toBe("revoked");
  });
});

describe("retries, mirrored waits, concurrency and what was left pending", () => {
  test("an update retried after a failed step keeps what the first attempt replaced", async () => {
    const unassignable = new Set(["ana.b"]);
    const { a, layer } = setup({ unassignable });
    const r = await inMock(
      layer,
      Effect.gen(function* () {
        yield* (yield* Sync).run();
        const { ids } = yield* seed([
          { kind: "update_issue", target: a.key, changes: { priority: "High", assignee: "ana.b" } },
        ]);
        const id = ids[0] ?? "";
        const svc = yield* Proposals;
        // The priority is written, then the assign fails.
        const first = yield* svc.approve(id);
        const afterFirst = { priority: a.priority, row: yield* statusOf(id) };
        unassignable.clear();
        const second = yield* svc.approve(id);
        const row = yield* statusOf(id);
        const revoked = yield* svc.revoke(id);
        return { first, afterFirst, second, row, revoked };
      }),
    );
    expect(r.first.status).toBe("failed");
    expect(r.afterFirst.priority).toBe("High");
    expect(r.afterFirst.row.result?.undo).toMatchObject({ before: { priority: "Low" } });
    expect(r.second.status).toBe("executed");
    // Not "High", which the retry found: the first attempt had already set it.
    expect(r.row.result?.undo).toMatchObject({
      before: { priority: "Low", assignee: "tom.k" },
      after: { priority: "High", assignee: "ana.b" },
    });
    expect(r.revoked.status).toBe("revoked");
    expect(a.priority).toBe("Low");
    expect(a.assignee?.name).toBe("tom.k");
  });

  test("a mirrored wait whose Jira link is already gone is still deleted, logged with the proposal", async () => {
    const { issues, layer } = setup();
    const r = await inMock(
      layer,
      Effect.gen(function* () {
        const t = yield* approveThread([
          TICKET,
          {
            kind: "link_dependency",
            target: "$new:1",
            dependencyKind: "team",
            label: "Finance export",
            externalUrl: "https://finance.example.com/q3",
          },
        ]);
        const depId = (t.results[1] as { dependencyId?: string } | undefined)?.dependencyId;
        const wait = yield* query((d) => d.select().from(dependencies).get());
        yield* mirror(wait?.id ?? "", true);
        const ticket = issues.get(t.key);
        const linked = ticket?.remoteLinks?.length ?? 0;
        // Someone removes the link in Jira.
        if (ticket) ticket.remoteLinks = [];
        const result = yield* (yield* Proposals).revoke(t.ids[1] ?? "");
        const logged = yield* query((d) =>
          d.select().from(actionsLog).where(eq(actionsLog.action, "delete_remote_link")).all(),
        );
        return {
          ...t,
          depId,
          linked,
          result,
          logged,
          waits: yield* query((d) => d.select().from(dependencies).all()),
        };
      }),
    );
    expect(r.linked).toBe(1);
    expect(r.result.status).toBe("revoked");
    expect(r.waits).toEqual([]);
    expect(r.logged.map((x) => x.proposalId)).toEqual([r.ids[1]]);
  });

  test("two Revokes of one bundle at once: one runs, the other says it is already running", async () => {
    const { issues, layer, requests } = setup({ canDelete: false });
    const r = await inMock(
      layer,
      Effect.gen(function* () {
        const t = yield* trackSmallAsk;
        const svc = yield* Proposals;
        const both = yield* Effect.all(
          [Effect.either(svc.revoke(t.ids[0] ?? "")), Effect.either(svc.revoke(t.ids[0] ?? ""))],
          { concurrency: 2 },
        );
        return { ...t, both };
      }),
    );
    const outcomes = r.both.map((x) => (x._tag === "Right" ? x.right.status : x.left));
    expect(outcomes.filter((x) => x === "revoked")).toHaveLength(1);
    expect(outcomes.find((x) => typeof x !== "string")).toMatchObject({
      _tag: "ProposalError",
      kind: "busy",
    });
    expect(issues.get(r.key)?.comments.map((c) => c.body)).toEqual([REVOKE_COMMENT]);
    expect(
      requests.filter((x) => x.method === "POST" && x.path.endsWith(`${r.key}/comment`)),
    ).toHaveLength(2); // the small ask's own comment, then the revoke comment once
  });

  test("a revoked small ask rejects the members still pending, and the thread is filed", async () => {
    const { layer } = setup({ canDelete: false });
    const r = await inMock(
      layer,
      Effect.gen(function* () {
        yield* (yield* Sync).run();
        const { inboxItemId, ids } = yield* seed([
          TICKET,
          { kind: "add_comment", target: "$new:1", bodyMd: "Asked finance." },
          { kind: "add_comment", target: "PAY-1", bodyMd: "Elsewhere." },
        ]);
        const svc = yield* Proposals;
        yield* svc.approve(ids[0] ?? "");
        yield* svc.reject(ids[2] ?? "");
        const result = yield* svc.revoke(ids[0] ?? "");
        const item = yield* query((d) =>
          d.select().from(inboxItems).where(eq(inboxItems.id, inboxItemId)).get(),
        );
        return { result, rows: yield* Effect.all(ids.map(statusOf)), item };
      }),
    );
    expect(r.result.status).toBe("revoked");
    expect(r.rows.map((x) => x.status)).toEqual(["revoked", "rejected", "rejected"]);
    expect(r.rows[1]?.result).toMatchObject({ dismissed: true });
    expect(r.item?.status).toBe("filed");
  });
});

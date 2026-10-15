/**
 * FR-14.6 over real HTTP: a small ask is tracked, a later turn adds a comment
 * (approved) and a move (left pending), the create is revoked, and the next turn
 * of the same thread tells the model what was revoked and what the revoke did,
 * lists the pending move as dropped rather than rejected, and no longer offers a
 * deleted ticket. Real Intake, Retrieval, Sync, Executor and Proposals against
 * scripts/mock-jira.ts; only the model is scripted.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { intakeItems, jiraIssues, proposals } from "@/db/schema";
import type { ItemSnapshot } from "@/prompts/classify";
import { query } from "@/services/db";
import { createPerson } from "@/services/directory/queries";
import { ExecutorLive } from "@/services/executor/live";
import { inboxDetail } from "@/services/inbox/queries";
import { LlmLive } from "@/services/llm/live";
import { makeScriptedModels } from "@/services/llm/test";
import { Proposals, type RevokedRecord } from "@/services/proposals";
import { ProposalsLive } from "@/services/proposals/live";
import { RetrievalLive } from "@/services/retrieval/live";
import { groupSmallAsks, trackOrder } from "@/services/small-asks/bundle";
import { Sync } from "@/services/sync";
import { SyncLive } from "@/services/sync/live";
import { promptOf, testProvider } from "@/test/helpers";
import { out } from "@/test/intake-layer";
import { jiraSettings, jiraTestLayer } from "@/test/layers";
import { createHandler, generate } from "../../../scripts/mock-jira";
import { Intake } from ".";
import { IntakeLive } from "./live";

const servers: { stop: (force?: boolean) => void }[] = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

const TODAY = "2026-10-05";
const e = { rationale: "Dana asked", evidence: "send me the Q3 numbers", confidence: 0.9 };
const first = {
  summary: "Dana wants the Q3 numbers",
  question: null,
  confidence: 0.9,
  proposals: [
    {
      kind: "create_issue",
      ref: "$new:1",
      smallAsk: "yes",
      summary: "Send Dana the Q3 numbers",
      description: "Totals per region.",
      dueDate: "2026-10-09",
      issueType: "",
      ...e,
    },
    {
      kind: "link_dependency",
      target: "$new:1",
      dependencyKind: "team",
      label: "Finance export of Q3 totals",
      ...e,
    },
  ],
};
const followUp = (key: string) => ({
  summary: "Dana wants the Q3 numbers",
  question: null,
  confidence: 0.9,
  proposals: [
    { kind: "add_comment", target: key, body: "Asked finance for the export.", ...e },
    { kind: "transition_issue", target: key, toStatus: "In Progress", ...e },
  ],
});
const last = {
  summary: "Dana wants the Q3 numbers",
  question: "What would you like to do next?",
  confidence: 0.5,
  proposals: [],
};

type Req = { method: string; path: string };

function setup(canDelete: boolean) {
  const issues = generate(40);
  const server = Bun.serve({
    port: 0,
    fetch: createHandler(issues, { canDelete, cancelStatus: true }),
  });
  servers.push(server);
  const requests: Req[] = [];
  const base = jiraTestLayer(
    (input, init) => {
      const req = new Request(input, init);
      requests.push({ method: req.method, path: new URL(req.url).pathname });
      return fetch(req);
    },
    {
      ...jiraSettings({ baseUrl: `http://localhost:${server.port}`, trackedEpics: [] }),
      providers: [testProvider],
      tiers: { fast: null, standard: { providerId: "p1", model: "std-m" }, strong: null },
      smallAsks: {
        projectKey: "PAY",
        label: "small-ask",
        joinActiveSprint: false,
        hintDismissed: false,
      },
    },
  );
  const models = makeScriptedModels({ "std-m": [out(first)] });
  const llm = Layer.provideMerge(
    LlmLive,
    Layer.merge(Layer.provideMerge(SyncLive, base), models.layer),
  );
  const layer = Layer.provideMerge(
    Layer.merge(IntakeLive, ProposalsLive),
    Layer.provideMerge(Layer.merge(RetrievalLive, ExecutorLive), llm),
  );
  return { layer, models, requests, issues };
}

/**
 * Tracks the ask, approves a follow-up comment, revokes the create, then asks
 * again. `deletedFirst`: someone deletes the ticket in Jira before the revoke.
 */
const run = (canDelete: boolean, deletedFirst = false) => {
  const { layer, models, requests, issues } = setup(canDelete);
  const queue = models.remaining().get("std-m");
  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        yield* (yield* Sync).run();
        const dana = yield* createPerson({ displayName: "Dana Reyes", title: "Finance lead" });
        const intake = yield* Intake;
        const svc = yield* Proposals;
        const turn = yield* intake.triage({
          text: "can you send me the Q3 numbers by Friday?",
          source: "teams",
          senderPersonId: dana,
          today: TODAY,
        });
        const thread = turn.inboxItemId;
        const row = groupSmallAsks((yield* inboxDetail(thread))?.proposals ?? [])[0];
        if (row?.type !== "track") throw new Error("expected a Track row");
        const tracked = yield* svc.track(trackOrder(row.create, row.members));
        const key = tracked[0]?.issueKey ?? "";

        // A later turn acts on the new ticket by its key; the comment is approved.
        queue?.push(out(followUp(key)));
        yield* intake.reply({
          inboxItemId: thread,
          instruction: "also tell them on the ticket that finance was asked, and start it",
          today: TODAY,
        });
        const pendingOf = (kind: string) =>
          query((d) =>
            d
              .select()
              .from(proposals)
              .where(
                and(
                  eq(proposals.inboxItemId, thread),
                  eq(proposals.kind, kind),
                  eq(proposals.status, "pending"),
                ),
              )
              .get(),
          );
        const comment = yield* svc.approve((yield* pendingOf("add_comment"))?.id ?? "");

        if (deletedFirst) issues.delete(key);
        const plan = yield* svc.revokePlan(row.create.id);
        const revoked = yield* svc.revoke(
          row.create.id,
          plan.entries.flatMap((x) => x.steps.map((s) => s.text)),
        );
        const record = (
          (yield* query((d) =>
            d
              .select({ result: proposals.result })
              .from(proposals)
              .where(eq(proposals.id, row.create.id))
              .get(),
          ))?.result as { revoked?: RevokedRecord } | null
        )?.revoked;
        const cached = yield* query((d) =>
          d.select().from(jiraIssues).where(eq(jiraIssues.key, key)).get(),
        );

        queue?.push(out(last));
        const before = requests.length;
        yield* intake.reply({ inboxItemId: thread, instruction: "what now?", today: TODAY });
        const items = yield* query((d) =>
          d.select().from(intakeItems).where(eq(intakeItems.inboxItemId, thread)).all(),
        );
        const newest = [...items].sort((a, b) => b.id.localeCompare(a.id))[0];
        const statuses = yield* query((d) =>
          d
            .select({ kind: proposals.kind, status: proposals.status })
            .from(proposals)
            .where(eq(proposals.inboxItemId, thread))
            .all(),
        );
        return {
          key,
          comment,
          revoked,
          record,
          cached,
          statuses,
          prompt: promptOf(models.calls, models.calls.length - 1),
          calls: models.calls.length,
          snapshot: newest?.snapshot as ItemSnapshot,
          reads: requests.slice(before),
        };
      }),
      layer,
    ),
  );
};

const kindsAndStatuses = (rows: { kind: string; status: string }[]) =>
  rows
    .filter((r) => r.kind !== "needs_clarification")
    .map((r) => `${r.kind}:${r.status}`)
    .sort();

describe("later turns of a thread know what was revoked (FR-14.6)", () => {
  test("deleted: approved then revoked, the move dropped, the key no longer a candidate", async () => {
    const r = await run(true);
    expect(r.comment.status).toBe("executed");
    expect(r.revoked.status).toBe("revoked");
    expect(r.calls).toBe(3);
    expect(kindsAndStatuses(r.statuses)).toEqual([
      "add_comment:revoked",
      "create_issue:revoked",
      "link_dependency:revoked",
      "transition_issue:rejected",
    ]);
    const p = r.prompt;
    expect(p).toContain(
      `- Approved, then revoked by the user: Create Task in PAY: Send Dana the Q3 numbers. Undone: ${r.key} was deleted and no longer exists.`,
    );
    expect(p).toContain(
      `- Approved, then revoked by the user: Comment on ${r.key}. Undone: Deleted the comment on ${r.key}.`,
    );
    expect(p).toContain(
      `- Approved, then revoked by the user: ${r.key} waits on Finance export of Q3 totals. Undone:`,
    );
    expect(p).toContain(
      `- Dropped without a decision (the ticket it acts on was revoked): Move ${r.key} to In Progress`,
    );
    expect(p).not.toContain("Rejected by the user");
    expect(p).toContain("A revoked action is undone.");
    // The deleted ticket is not offered, not named as a reference and not read again.
    expect(r.snapshot.promptVersion).toBe(11);
    expect(r.snapshot.candidates.map((c) => c.key)).not.toContain(r.key);
    expect(r.snapshot.references.issueKeys).not.toContain(r.key);
    expect(r.reads.filter((x) => x.path.includes(`/issue/${r.key}`))).toEqual([]);
    expect(r.record?.ticket).toEqual({ key: r.key, state: "deleted" });
    expect(r.cached).toBeUndefined();
  });

  test("deleted in Jira before the revoke: it leaves the cache and is no candidate", async () => {
    const r = await run(true, true);
    expect(r.revoked.status).toBe("revoked");
    expect(r.record).toMatchObject({
      ticket: { key: r.key, state: "deleted" },
      unchanged: true,
    });
    // Forgotten locally like a delete Secretary made, so search and recent miss it.
    expect(r.cached).toBeUndefined();
    expect(r.prompt).toContain(
      `- Approved, then revoked by the user: Create Task in PAY: Send Dana the Q3 numbers. Undone: ${r.key} was deleted and no longer exists.`,
    );
    expect(r.snapshot.candidates.map((c) => c.key)).not.toContain(r.key);
    expect(r.snapshot.references.issueKeys).not.toContain(r.key);
  });

  test("closed: the status it was moved to, and it stays a candidate in that status", async () => {
    const r = await run(false);
    expect(r.revoked.status).toBe("revoked");
    expect(r.record?.ticket).toEqual({
      key: r.key,
      state: "closed",
      status: "Cancelled",
      moved: true,
    });
    expect(r.prompt).toContain(
      `- Approved, then revoked by the user: Create Task in PAY: Send Dana the Q3 numbers. Undone: ${r.key} was closed and moved to Cancelled.`,
    );
    expect(r.prompt).toContain(
      `- Dropped without a decision (the ticket it acts on was revoked): Move ${r.key} to In Progress`,
    );
    expect(r.snapshot.candidates.find((c) => c.key === r.key)?.status).toBe("Cancelled");
  });
});

/**
 * FR-14.6 across threads, over real HTTP: thread A tracks a small ask (after a
 * revision, so a correction example is stored) and revokes it; a full and an
 * incremental sync run; then a new thread B about the same work is classified.
 * Deleted: the mock's search index lags, as Cloud's may, so the sync is offered
 * the deleted ticket again; it must not come back as a candidate, a reference or
 * a valid target. Closed (no delete permission): it stays a candidate, marked as
 * revoked. Real Intake, Retrieval, Sync, Executor and Proposals against
 * scripts/mock-jira.ts; only the model is scripted.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import {
  deletedIssues,
  dependencies,
  intakeItems,
  issueMeta,
  jiraIssues,
  proposals,
} from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { type ItemOutput, type ItemSnapshot, validateItemOutput } from "@/prompts/classify";
import { query } from "@/services/db";
import { createPerson } from "@/services/directory/queries";
import { ExecutorLive } from "@/services/executor/live";
import { inboxDetail } from "@/services/inbox/queries";
import { LlmLive } from "@/services/llm/live";
import { makeScriptedModels } from "@/services/llm/test";
import { Proposals } from "@/services/proposals";
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
const ask = (dueDate: string) => ({
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
      dueDate,
      issueType: "",
      ...e,
    },
  ],
});
/** What thread B's model tries when the ticket was deleted: a comment on it. */
const commentOn = (key: string) => ({
  summary: "Dana chases the Q3 numbers",
  question: null,
  confidence: 0.9,
  proposals: [{ kind: "add_comment", target: key, body: "Still on it.", ...e }],
});
/** The reported symptom: a question about the revoked ticket, from the other thread. */
const askAbout = (key: string) => ({
  summary: "Dana chases the Q3 numbers",
  question: `Since you previously asked why it is due Friday, should ${key} be due Thursday?`,
  confidence: 0.5,
  proposals: [],
});

function setup(canDelete: boolean) {
  const issues = generate(40);
  const server = Bun.serve({
    port: 0,
    fetch: createHandler(issues, { canDelete, cancelStatus: true, laggingSearch: true }),
  });
  servers.push(server);
  const base = jiraTestLayer(fetch, {
    ...jiraSettings({ baseUrl: `http://localhost:${server.port}`, trackedEpics: [] }),
    providers: [testProvider],
    tiers: { fast: null, standard: { providerId: "p1", model: "std-m" }, strong: null },
    smallAsks: {
      projectKey: "PAY",
      label: "small-ask",
      joinActiveSprint: false,
      hintDismissed: false,
    },
  });
  const models = makeScriptedModels({ "std-m": [out(ask("2026-10-09"))] });
  const llm = Layer.provideMerge(
    LlmLive,
    Layer.merge(Layer.provideMerge(SyncLive, base), models.layer),
  );
  const layer = Layer.provideMerge(
    Layer.merge(IntakeLive, ProposalsLive),
    Layer.provideMerge(Layer.merge(RetrievalLive, ExecutorLive), llm),
  );
  return { layer, models, issues };
}

const run = (canDelete: boolean) => {
  const { layer, models, issues } = setup(canDelete);
  const queue = models.remaining().get("std-m");
  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const sync = yield* Sync;
        yield* sync.run();
        const dana = yield* createPerson({ displayName: "Dana Reyes", title: "Finance lead" });
        const intake = yield* Intake;
        const svc = yield* Proposals;

        // Thread A: the ask, a revision the user asks for (a correction example), Track.
        const a = yield* intake.triage({
          text: "can you send me the Q3 numbers by Friday?",
          source: "teams",
          senderPersonId: dana,
          today: TODAY,
        });
        queue?.push(out(ask("2026-10-08")));
        yield* intake.reply({
          inboxItemId: a.inboxItemId,
          instruction: "why is it due Friday? make it Thursday",
          today: TODAY,
        });
        const row = groupSmallAsks((yield* inboxDetail(a.inboxItemId))?.proposals ?? [])[0];
        if (row?.type !== "track") throw new Error("expected a Track row");
        const tracked = yield* svc.track(trackOrder(row.create, row.members));
        const key = tracked[0]?.issueKey ?? "";
        const plan = yield* svc.revokePlan(row.create.id);
        const revoked = yield* svc.revoke(
          row.create.id,
          plan.entries.flatMap((x) => x.steps.map((s) => s.text)),
        );

        // Both kinds of sync after the revoke.
        const full = yield* sync.run({ full: true });
        const incremental = yield* sync.run();
        const cached = yield* query((d) =>
          d.select().from(jiraIssues).where(eq(jiraIssues.key, key)).get(),
        );
        const tomb = yield* query((d) =>
          d.select().from(deletedIssues).where(eq(deletedIssues.issueKey, key)).get(),
        );
        const metaOf = () =>
          query((d) => d.select().from(issueMeta).where(eq(issueMeta.issueKey, key)).get());
        const meta = yield* metaOf();

        /** A new thread; the scripted answer is given twice when validation must fail. */
        const thread = (text: string, answer: object, failing: boolean) =>
          Effect.gen(function* () {
            queue?.push(out(answer), ...(failing ? [out(answer)] : []));
            const before = models.calls.length;
            const t = yield* intake.triage({
              text,
              source: "teams",
              senderPersonId: dana,
              today: TODAY,
            });
            const item = yield* query((d) =>
              d.select().from(intakeItems).where(eq(intakeItems.inboxItemId, t.inboxItemId)).get(),
            );
            // A proposal on the ticket left pending in this thread.
            const stray = newId();
            yield* query((d) =>
              d.insert(proposals).values({
                id: stray,
                inboxItemId: t.inboxItemId,
                kind: "add_comment",
                payload: { kind: "add_comment", target: key, bodyMd: "Still on it." },
                status: "pending",
                createdAt: nowIso(),
              }),
            );
            return {
              item,
              snapshot: item?.snapshot as ItemSnapshot,
              prompt: promptOf(models.calls, before),
              calls: models.calls.length - before,
              approved: yield* Effect.either(svc.approve(stray)),
            };
          });

        if (canDelete) {
          // Thread B names the deleted ticket; the model tries a comment on it.
          const b = yield* thread(
            `Dana again: did you send the Q3 numbers yet? (${key})`,
            commentOn(key),
            true,
          );
          // A draft that mentions it and a wait update on it are not refused.
          const waitId = newId();
          yield* query((d) =>
            d.insert(dependencies).values({
              id: waitId,
              issueKey: key,
              kind: "team",
              label: "Finance export",
              status: "waiting",
            }),
          );
          const pending = (payload: { kind: string } & Record<string, unknown>) =>
            Effect.gen(function* () {
              const id = newId();
              yield* query((d) =>
                d.insert(proposals).values({
                  id,
                  inboxItemId: b.item?.inboxItemId ?? null,
                  kind: payload.kind,
                  payload,
                  status: "pending",
                  createdAt: nowIso(),
                }),
              );
              return yield* svc.approve(id);
            });
          const draft = yield* pending({
            kind: "draft_message",
            channel: "teams",
            intent: "status_update",
            recipientPersonId: dana,
            issueKeys: [key],
            notes: "The Q3 numbers ticket was withdrawn.",
          });
          const waitUpdate = yield* pending({
            kind: "update_dependency",
            dependencyId: waitId,
            action: "resolve",
            issueKey: key,
          });
          return { key, revoked, full, incremental, cached, tomb, meta, b, draft, waitUpdate };
        }
        // Thread B does not name the closed ticket; the model asks about it anyway.
        const b = yield* thread(
          "Dana again: did you send the Q3 numbers yet?",
          askAbout(key),
          true,
        );
        // Thread C names it: offered, marked as revoked in another conversation.
        const c = yield* thread(
          `Dana: please reopen ${key}, we need the Q3 numbers after all`,
          askAbout(key),
          false,
        );
        // Reopened in Jira: the next sync clears the mark; so does a refresh after a write.
        const issue = issues.get(key);
        if (!issue) throw new Error("the closed ticket is in the mock");
        issue.status = "To Do";
        issue.updated = new Date().toISOString().replace("Z", "+0000");
        yield* sync.run();
        const afterSync = yield* metaOf();
        yield* query((d) =>
          d.update(issueMeta).set({ revokedAt: nowIso() }).where(eq(issueMeta.issueKey, key)),
        );
        issue.status = "In Progress";
        yield* sync.refreshIssue(key);
        const afterRefresh = yield* metaOf();
        return {
          key,
          revoked,
          full,
          incremental,
          cached,
          tomb,
          meta,
          b,
          c,
          afterSync,
          afterRefresh,
        };
      }),
      layer,
    ),
  );
};

const noExample = (prompt: string) => {
  // Thread A's correction is not offered: its ticket was revoked.
  expect(prompt).not.toContain("Past corrections");
  expect(prompt).not.toContain("why is it due Friday");
};

describe("a revoked ticket stays revoked in every thread (FR-14.6)", () => {
  test("deleted: not re-synced, not a candidate or reference in thread B, and no valid target", async () => {
    const r = await run(true);
    expect(r.revoked.status).toBe("revoked");
    expect(r.full.full).toBe(true);
    expect(r.incremental.full).toBe(false);
    // The lagging search offered it to both syncs; neither stored it again.
    expect(r.cached).toBeUndefined();
    expect(r.tomb?.issueKey).toBe(r.key);
    const s = r.b.snapshot;
    expect(s.candidates.map((c) => c.key)).not.toContain(r.key);
    expect(s.references.issueKeys).not.toContain(r.key);
    expect(s.deleted).toEqual([r.key]);
    // The scripted comment on it fails validation, saying why; in the run the
    // schema already refuses the key, so the repair fails too and nothing is stored.
    expect(validateItemOutput(commentOn(r.key) as ItemOutput, s)).toEqual([
      `Proposal 1 (add_comment): target ${r.key} was deleted when the user revoked it, so it no longer exists. Do not target, comment on or link to it.`,
    ]);
    expect(r.b.calls).toBe(2);
    expect(r.b.item?.error).toContain("failed validation");
    expect(r.b.item?.output).toBeNull();
    noExample(r.b.prompt);
    expect(r.draft?.status).toBe("executed");
    expect(r.waitUpdate?.status).toBe("executed");
    expect(r.b.approved._tag).toBe("Left");
    if (r.b.approved._tag === "Left")
      expect(r.b.approved.left.message).toBe(
        `${r.key} was deleted when you revoked it, so this can no longer run. Reject it instead.`,
      );
  });

  test("closed: not found by search, not to be mentioned unless named, and marked when named", async () => {
    const r = await run(false);
    expect(r.revoked.status).toBe("revoked");
    expect(r.cached?.status).toBe("Cancelled");
    expect(r.tomb).toBeUndefined();
    expect(r.meta?.revokedAt).toBeTruthy();
    if (!r.c) throw new Error("closed run has thread C");
    // Thread B: search reaches it, but it is not offered, and asking about it fails.
    expect(r.b.snapshot.candidates.map((x) => x.key)).not.toContain(r.key);
    expect(r.b.snapshot.revokedClosed).toEqual([r.key]);
    noExample(r.b.prompt);
    expect(r.b.calls).toBe(2);
    expect(r.b.item?.output).toBeNull();
    expect(r.b.item?.error).toContain(
      `The question names ${r.key}, a ticket the user revoked (it was closed). Do not mention it unless the user names it.`,
    );
    // Thread C names it: offered as revoked in another conversation, and may be asked about.
    expect(r.c.snapshot.candidates.find((x) => x.key === r.key)?.revoked).toBe("elsewhere");
    expect(r.c.prompt).toMatch(
      new RegExp(
        `- ${r.key} \\[Task, Cancelled[^\\]]*\\] Send Dana the Q3 numbers \\(mentioned[^)]*\\); created by mistake and revoked by the user in another conversation \\(closed\\)`,
      ),
    );
    expect(r.c.prompt).toContain(
      'A candidate marked \\"created by mistake and revoked by the user\\" was closed by that revoke.',
    );
    expect(r.c.calls).toBe(1);
    expect(r.c.item?.output).toBeTruthy();
    // A closed ticket still exists: acting on it is the user's call.
    expect(r.c.approved._tag).toBe("Right");
    // Reopened: the mark goes, by sync and by a refresh.
    expect(r.afterSync?.revokedAt).toBeNull();
    expect(r.afterRefresh?.revokedAt).toBeNull();
  });
});

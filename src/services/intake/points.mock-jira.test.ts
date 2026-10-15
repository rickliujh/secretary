/**
 * FR-15 acceptance over real HTTP (Phase 18 checklist): a pasted ask that states
 * 3 points creates a ticket with 3 points; one that states none gets a
 * suggestion from the scale, or the small-ask default when one is set; "X is
 * more like a 5" proposes an update that sets 5, and revoking it puts the old
 * value back. A create screen without the field creates with a warning, and an
 * update without it fails naming why. Real Intake, Retrieval, Sync, Executor and
 * Proposals against scripts/mock-jira.ts; only the model is scripted.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { intakeItems } from "@/db/schema";
import type { ItemSnapshot } from "@/prompts/classify";
import { query } from "@/services/db";
import { ExecutorLive } from "@/services/executor/live";
import { inboxDetail } from "@/services/inbox/queries";
import { Intake } from "@/services/intake";
import { IntakeLive } from "@/services/intake/live";
import { LlmLive } from "@/services/llm/live";
import { makeScriptedModels } from "@/services/llm/test";
import { Proposals } from "@/services/proposals";
import { ProposalsLive } from "@/services/proposals/live";
import type { ProposalPayload } from "@/services/proposals/schema";
import { RetrievalLive } from "@/services/retrieval/live";
import { groupSmallAsks, trackOrder } from "@/services/small-asks/bundle";
import { Sync } from "@/services/sync";
import { SyncLive } from "@/services/sync/live";
import { testProvider } from "@/test/helpers";
import { out } from "@/test/intake-layer";
import { jiraSettings, jiraTestLayer } from "@/test/layers";
import { createHandler, generate, type MockOptions } from "../../../scripts/mock-jira";

const servers: { stop: (force?: boolean) => void }[] = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

const e = { rationale: "From the input", evidence: "points", confidence: 0.9 };
const answer = (...proposals: Record<string, unknown>[]) => ({
  summary: "s",
  question: null,
  confidence: 0.9,
  proposals,
});
const story = (points: Record<string, unknown>) => ({
  kind: "create_issue",
  ref: "$new:1",
  projectKey: "PAY",
  issueType: "Story",
  summary: "Export credit notes to the ledger",
  ...points,
  ...e,
});

function setup(
  modelAnswer: unknown,
  opts: { mock?: MockOptions; defaultPoints?: number | null } = {},
) {
  const issues = generate(80);
  // A story to re-estimate: 3 points, not done.
  const target = [...issues.values()].find(
    (i) => i.project === "PAY" && i.type === "Story" && i.status !== "Done",
  );
  const epic = [...issues.values()].find((i) => i.project === "PAY" && i.type === "Epic");
  if (!target || !epic) throw new Error("fixture");
  target.points = 3;
  const server = Bun.serve({ port: 0, fetch: createHandler(issues, opts.mock) });
  servers.push(server);
  const base = jiraTestLayer((input, init) => fetch(input, init), {
    ...jiraSettings({
      baseUrl: `http://localhost:${server.port}`,
      trackedEpics: [],
      ...(opts.mock?.cloud ? { deployment: "cloud" as const, email: "me@example.com" } : {}),
    }),
    providers: [testProvider],
    tiers: { fast: null, standard: { providerId: "p1", model: "std-m" }, strong: null },
    ...(opts.defaultPoints !== undefined
      ? {
          smallAsks: {
            projectKey: "PAY",
            label: "small-ask",
            joinActiveSprint: false,
            hintDismissed: false,
            defaultPoints: opts.defaultPoints,
          },
        }
      : {}),
  });
  // One answer per turn; an array scripts a thread's turns in order.
  const answers = Array.isArray(modelAnswer) ? modelAnswer : [modelAnswer];
  const models = makeScriptedModels({ "std-m": answers.map(out) });
  const llm = Layer.provideMerge(
    LlmLive,
    Layer.merge(Layer.provideMerge(SyncLive, base), models.layer),
  );
  const layer = Layer.provideMerge(
    Layer.merge(IntakeLive, ProposalsLive),
    Layer.provideMerge(Layer.merge(RetrievalLive, ExecutorLive), llm),
  );
  return { issues, target, epic, layer, calls: models.calls };
}

/** Pastes `text`, then approves every proposal the turn made (a small ask with Track). */
const pasteAndApprove = (text: string) =>
  Effect.gen(function* () {
    yield* (yield* Sync).run();
    const turn = yield* (yield* Intake).triage({
      text,
      source: "teams",
      senderPersonId: null,
      today: "2026-10-05",
    });
    const detail = yield* inboxDetail(turn.inboxItemId);
    const rows = detail?.proposals ?? [];
    const svc = yield* Proposals;
    const grouped = groupSmallAsks(rows);
    const results =
      grouped[0]?.type === "track"
        ? yield* svc.track(trackOrder(grouped[0].create, grouped[0].members))
        : [yield* svc.approve(rows[0]?.id ?? "")];
    const item = yield* query((d) =>
      d
        .select({ snapshot: intakeItems.snapshot })
        .from(intakeItems)
        .where(eq(intakeItems.inboxItemId, turn.inboxItemId))
        .get(),
    );
    const snapshot = (item?.snapshot ?? null) as ItemSnapshot | null;
    return {
      id: rows[0]?.id ?? "",
      payload: (rows[0]?.payload ?? null) as ProposalPayload | null,
      results,
      snapshot,
    };
  });

describe("story points on proposals against the mock Jira (FR-15 AC)", () => {
  test("stated points: a 3-pointer is created with 3 points", async () => {
    const { issues, layer } = setup(answer(story({ storyPoints: "3", pointsSource: "stated" })));
    const r = await Effect.runPromise(
      Effect.provide(
        pasteAndApprove("We need a story to export credit notes to the ledger. It's a 3-pointer."),
        layer,
      ),
    );
    // Code offered the scale the mock's tickets use.
    expect(r.snapshot?.pointScale).toEqual([1, 2, 3, 5, 8, 13]);
    expect(r.payload).toMatchObject({ storyPoints: 3, storyPointsEstimated: false });
    expect(r.results[0]?.status).toBe("executed");
    expect(r.results[0]?.warning).toBeUndefined();
    expect(issues.get(r.results[0]?.issueKey ?? "")?.points).toBe(3);
  });

  test("no points stated: a suggestion from the scale, marked as one", async () => {
    const { issues, layer } = setup(answer(story({ storyPoints: "5", pointsSource: "estimated" })));
    const r = await Effect.runPromise(
      Effect.provide(
        pasteAndApprove("We need a story to export credit notes to the ledger."),
        layer,
      ),
    );
    expect(r.payload).toMatchObject({ storyPoints: 5, storyPointsEstimated: true });
    expect(issues.get(r.results[0]?.issueKey ?? "")?.points).toBe(5);
  });

  test("a small ask without stated points gets the default from Settings", async () => {
    const ask = {
      kind: "create_issue",
      ref: "$new:1",
      smallAsk: "yes",
      summary: "Send Dana the Q3 numbers",
      storyPoints: "5",
      pointsSource: "estimated",
      ...e,
    };
    const { issues, layer } = setup(answer(ask), { defaultPoints: 1 });
    const r = await Effect.runPromise(
      Effect.provide(pasteAndApprove("can you send me the Q3 numbers by Friday?"), layer),
    );
    expect(r.payload).toMatchObject({
      smallAsk: true,
      storyPoints: 1,
      storyPointsEstimated: false,
    });
    expect(r.results[0]?.status).toBe("executed");
    expect(issues.get(r.results[0]?.issueKey ?? "")?.points).toBe(1);
  });

  test('"X is more like a 5" sets 5, and revoking it puts 3 back', async () => {
    const issues0 = generate(80);
    const key = [...issues0.values()].find(
      (i) => i.project === "PAY" && i.type === "Story" && i.status !== "Done",
    )?.key;
    const update = {
      kind: "update_issue",
      target: key,
      storyPoints: "5",
      pointsSource: "stated",
      ...e,
    };
    const { target, layer } = setup(answer(update));
    expect(target.key).toBe(key ?? "");
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const done = yield* pasteAndApprove(`${target.key} is more like a 5`);
          const afterApprove = target.points;
          const revoked = yield* (yield* Proposals).revoke(done.id);
          return { ...done, afterApprove, revoked };
        }),
        layer,
      ),
    );
    expect(r.payload).toEqual({
      kind: "update_issue",
      target: target.key,
      changes: { storyPoints: 5 },
    });
    expect(r.results[0]?.status).toBe("executed");
    expect(r.afterApprove).toBe(5);
    expect(r.revoked).toMatchObject({
      status: "revoked",
      undone: [`Set the story points back to 3 on ${target.key}`],
    });
    expect(target.points).toBe(3);
  });

  test('a bare "1" answering the points question sets 1 on the existing ticket', async () => {
    const issues0 = generate(80);
    const key = [...issues0.values()].find(
      (i) => i.project === "PAY" && i.type === "Story" && i.status !== "Done",
    )?.key;
    const question = {
      summary: "Story points",
      question: `How many story points should ${key} have?`,
      confidence: 0.6,
      proposals: [],
    };
    const update = { kind: "update_issue", target: key, storyPoints: "1", pointsSource: "stated" };
    const { target, layer, calls } = setup([question, answer({ ...update, ...e })]);
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* (yield* Sync).run();
          const intake = yield* Intake;
          const turn = yield* intake.triage({
            text: `What are the story points on ${target.key}? Can you set them?`,
            source: "typed",
            senderPersonId: null,
            today: "2026-10-05",
          });
          const asked = (yield* inboxDetail(turn.inboxItemId))?.proposals.find(
            (p) => p.kind === "needs_clarification",
          );
          yield* intake.reply({
            inboxItemId: turn.inboxItemId,
            instruction: "1",
            answers: asked?.id ?? null,
            today: "2026-10-05",
          });
          const rows = (yield* inboxDetail(turn.inboxItemId))?.proposals ?? [];
          const pending = rows.filter((p) => p.status === "pending");
          const result = yield* (yield* Proposals).approve(pending[0]?.id ?? "");
          const items = yield* query((d) =>
            d
              .select({ error: intakeItems.error })
              .from(intakeItems)
              .where(eq(intakeItems.inboxItemId, turn.inboxItemId))
              .all(),
          );
          return { asked, pending, result, errors: items.map((i) => i.error).filter(Boolean) };
        }),
        layer,
      ),
    );
    expect(r.asked?.payload).toEqual({
      kind: "needs_clarification",
      question: `How many story points should ${target.key} have?`,
    });
    // The answer validated the first time: no repair call, no error, one update.
    expect(calls).toHaveLength(2);
    expect(r.errors).toEqual([]);
    expect(r.pending.map((p) => p.payload)).toEqual([
      { kind: "update_issue", target: target.key, changes: { storyPoints: 1 } },
    ]);
    expect(r.result.status).toBe("executed");
    expect(target.points).toBe(1);
  });

  test("a create screen without the field creates without points, with a warning", async () => {
    const { issues, layer } = setup(answer(story({ storyPoints: "3", pointsSource: "stated" })), {
      mock: { noPointsOnCreate: new Set(["PAY"]) },
    });
    const r = await Effect.runPromise(
      Effect.provide(
        pasteAndApprove("We need a story to export credit notes to the ledger. It's a 3-pointer."),
        layer,
      ),
    );
    expect(r.results[0]?.status).toBe("executed");
    expect(r.results[0]?.warning).toBe(
      "The Story create screen in PAY has no Story Points field, so it was created without its 3 points.",
    );
    expect(issues.get(r.results[0]?.issueKey ?? "")?.points).toBeNull();
  });

  test("an update whose edit screen has no story point field fails, naming why", async () => {
    // Epics have no story point field on the mock's edit screen.
    const issues0 = generate(80);
    const epicKey = [...issues0.values()].find(
      (i) => i.project === "PAY" && i.type === "Epic",
    )?.key;
    const update = {
      kind: "update_issue",
      target: epicKey,
      summary: "Billing migration, phase 2",
      ...e,
    };
    const { epic, layer } = setup(answer(update));
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* (yield* Sync).run();
          const turn = yield* (yield* Intake).triage({
            text: `Rename ${epic.key} to phase 2`,
            source: "teams",
            senderPersonId: null,
            today: "2026-10-05",
          });
          const row = (yield* inboxDetail(turn.inboxItemId))?.proposals[0];
          const payload = row?.payload as ProposalPayload;
          if (payload?.kind !== "update_issue") throw new Error("expected an update");
          // The user adds points in the edit dialog before approving.
          return yield* (yield* Proposals).approve(row?.id ?? "", {
            ...payload,
            changes: { ...payload.changes, storyPoints: 5 },
          });
        }),
        layer,
      ),
    );
    expect(r.status).toBe("failed");
    expect(r.message).toBe(
      `The edit screen of ${epic.key} has no story point field, so its story points cannot be set. Add the field to the screen in Jira, or remove the points from the proposal.`,
    );
    expect(epic.summary).not.toBe("Billing migration, phase 2");
  });

  test("Cloud with both fields: a new ticket gets the first on its screen, a re-estimate the one holding its points", async () => {
    const issues0 = generate(80);
    const key = [...issues0.values()].find(
      (i) => i.project === "PAY" && i.type === "Story" && i.status !== "Done",
    )?.key;
    const created = setup(answer(story({ storyPoints: "3", pointsSource: "stated" })), {
      mock: { cloud: true },
    });
    const c = await Effect.runPromise(
      Effect.provide(
        pasteAndApprove("We need a story to export credit notes to the ledger. It's a 3-pointer."),
        created.layer,
      ),
    );
    const made = created.issues.get(c.results[0]?.issueKey ?? "");
    // "Story point estimate" comes first (D35) and the create screen has it.
    expect(made?.estimate).toBe(3);
    expect(made?.points).toBeNull();

    const updated = setup(
      answer({ kind: "update_issue", target: key, storyPoints: "5", pointsSource: "stated", ...e }),
      { mock: { cloud: true } },
    );
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const done = yield* pasteAndApprove(`${updated.target.key} is more like a 5`);
          const after = { points: updated.target.points, estimate: updated.target.estimate };
          const revoked = yield* (yield* Proposals).revoke(done.id);
          return { ...done, after, revoked };
        }),
        updated.layer,
      ),
    );
    // The ticket holds its 3 in "Story Points", so the 5 goes there, not to the empty field.
    expect(r.results[0]?.status).toBe("executed");
    expect(r.after).toEqual({ points: 5, estimate: undefined });
    expect(r.revoked.status).toBe("revoked");
    expect(updated.target.points).toBe(3);
  });

  test("the mock refuses, like Jira, fields a screen lacks and points that are not a number", async () => {
    const issues = generate(20);
    const epic = [...issues.values()].find((i) => i.type === "Epic");
    const story0 = [...issues.values()].find((i) => i.type === "Story");
    if (!epic || !story0) throw new Error("fixture");
    const server = Bun.serve({
      port: 0,
      fetch: createHandler(issues, { noPointsOnCreate: new Set(["OPS"]) }),
    });
    servers.push(server);
    const send = (method: string, path: string, fields: Record<string, unknown>) =>
      fetch(`http://localhost:${server.port}/rest/api/2/${path}`, {
        method,
        headers: { authorization: "Bearer x", "content-type": "application/json" },
        body: JSON.stringify({ fields }),
      });
    const put = await send("PUT", `issue/${epic.key}`, { customfield_10106: 5 });
    expect({ status: put.status, body: await put.json() }).toEqual({
      status: 400,
      body: {
        errorMessages: [],
        errors: {
          customfield_10106:
            "Field 'customfield_10106' cannot be set. It is not on the appropriate screen, or unknown.",
        },
      },
    });
    const create = (project: string, type: string, extra: Record<string, unknown>) =>
      send("POST", "issue", {
        project: { key: project },
        issuetype: { id: type },
        summary: "x",
        ...extra,
      });
    expect((await create("OPS", "Task", { customfield_10106: 3 })).status).toBe(400);
    const sub = await create("PAY", "Sub-task", {
      customfield_10106: 3,
      parent: { key: story0.key },
    });
    expect(sub.status).toBe(400);
    expect((await create("PAY", "Task", { customfield_10106: "3" })).status).toBe(400);
    expect((await create("PAY", "Task", { customfield_10106: 3 })).status).toBe(201);
    expect((await send("PUT", `issue/${story0.key}`, { customfield_10106: "5" })).status).toBe(400);
    expect((await send("PUT", `issue/${story0.key}`, { customfield_10106: null })).status).toBe(
      204,
    );
  });
});

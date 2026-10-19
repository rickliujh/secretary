/**
 * FR-19.7 acceptance (Phase 26) over real HTTP against scripts/mock-jira.ts:
 * real Sync, Chat, Intake, Proposals and Executor; only the model is scripted.
 *
 * - "I'm waiting on Sarah for the cert" in the chat gives one card: their
 *   ticket found in Platform's project (PLAT-812, pre-selected), the wait, the
 *   comment, no Blocked move (the instruction is off), the request draft.
 *   Approving it shows the link, the comment and the remote link on the mock.
 * - With "Blocked" switched on, the same on another ticket adds the move; the
 *   user picks "None of these", so no link is made and nothing is learned.
 * - Sarah's "it's done" paste gives a `wait_resolved` card whose approval
 *   resolves the wait, comments, moves the ticket back and wakes it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { UIMessage, UIMessageChunk } from "ai";
import { asc, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import {
  bundles,
  communications,
  dependencies,
  issueMeta,
  jiraIssues,
  memories,
  people,
  proposals,
  teams,
} from "@/db/schema";
import { Chat } from "@/services/chat";
import { ChatLive } from "@/services/chat/live";
import { ConfluenceClientLive } from "@/services/confluence/live";
import { blockLinks } from "@/services/dashboard/sections";
import { query } from "@/services/db";
import { ExecutorLive } from "@/services/executor/live";
import { Intake } from "@/services/intake";
import { IntakeLive } from "@/services/intake/live";
import { JiraClient } from "@/services/jira";
import { parseIssueLinks } from "@/services/jira/schemas";
import { LlmLive } from "@/services/llm/live";
import { makeScriptedModels, type Scripted } from "@/services/llm/test";
import { Proposals } from "@/services/proposals";
import { ProposalsLive } from "@/services/proposals/live";
import { RetrievalLive } from "@/services/retrieval/live";
import { Settings } from "@/services/settings";
import { SourcesLive } from "@/services/sources/live";
import { makeObsidianCliTest } from "@/services/sources/test";
import { Sync } from "@/services/sync";
import { SyncLive } from "@/services/sync/live";
import { drainStream, testProvider } from "@/test/helpers";
import { out } from "@/test/intake-layer";
import { jiraSettings, jiraTestLayer } from "@/test/layers";
import { createHandler, generate } from "../../../scripts/mock-jira";
import { bundleRecordOf } from "./schema";

const servers: { stop: (force?: boolean) => void }[] = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

const e = { rationale: "the user said so", evidence: "waiting on Sarah", confidence: 0.9 };
const jiraNow = () => new Date().toISOString().replace("Z", "+0000");
const ask = (text: string): UIMessage[] => [
  { id: "u1", role: "user", parts: [{ type: "text", text }] },
];
const toolOutputs = (chunks: UIMessageChunk[]) =>
  chunks.flatMap((c) => (c.type === "tool-output-available" ? [c.output] : []));

const waitOn = (target: string) => ({
  kind: "link_dependency",
  target,
  dependencyKind: "person",
  label: "the payments cert",
  ownerPersonId: "c-sarah",
  ...e,
});
const answer = (proposals: Record<string, unknown>[]) => ({
  summary: "Waiting on Sarah for the payments cert",
  question: null,
  confidence: 0.9,
  proposals,
});

/** Scripted answers in order; `resolved` texts are filled in once the waits exist. */
type Script = (keys: { first: string; second: string }, resolved: { text: string }[]) => Scripted[];

function setup(script?: Script) {
  const issues = generate(40);
  const all = [...issues.values()];
  const me = all.find((i) => i.assignee?.name === "me")?.assignee;
  const ana = all.find((i) => i.assignee?.name === "ana.b")?.assignee;
  if (!me || !ana) throw new Error("fixture: users");
  for (const i of all) if (i.assignee?.name === "me") i.assignee = ana;
  const mine = all.filter(
    (i) => i.project === "PAY" && (i.type === "Story" || i.type === "Task") && !i.parent,
  );
  const [first, second] = mine;
  if (!first || !second) throw new Error("fixture: two PAY tickets");
  for (const [t, summary] of [
    [first, "Install the gateway certificate"],
    [second, "Switch the checkout to the new gateway"],
  ] as const)
    Object.assign(t, {
      summary,
      status: "In Progress",
      assignee: me,
      epic: null,
      links: [],
      due: null,
      updated: jiraNow(),
    });
  const server = Bun.serve({ port: 0, fetch: createHandler(issues) });
  servers.push(server);
  const base = jiraTestLayer((input, init) => fetch(input, init), {
    ...jiraSettings({ baseUrl: `http://localhost:${server.port}`, trackedEpics: [] }),
    providers: [testProvider],
    tiers: {
      fast: { providerId: "p1", model: "fast-m" },
      standard: { providerId: "p1", model: "std-m" },
      strong: null,
    },
  });
  // A resolve names a wait, whose id exists only once it is approved.
  const later = [{ text: "" }, { text: "" }];
  const resolved = later[0] ?? { text: "" };
  const models = makeScriptedModels({
    "std-m": script?.({ first: first.key, second: second.key }, later) ?? [
      // The chat hands the request to intake.
      {
        toolCall: {
          name: "propose_actions",
          input: { request: `I'm waiting on Sarah for the payments cert on ${first.key}` },
        },
      },
      out(answer([waitOn(first.key)])),
      { text: "One card: the wait, their ticket, a comment and the request to Sarah." },
      // The same on the second ticket, with Blocked switched on.
      out(answer([waitOn(second.key)])),
      // Sarah: it is done.
      resolved,
    ],
  });
  const llm = Layer.provideMerge(
    Layer.merge(LlmLive, ConfluenceClientLive),
    Layer.merge(Layer.provideMerge(SyncLive, base), models.layer),
  );
  const layer = Layer.provideMerge(
    ChatLive,
    Layer.provideMerge(
      Layer.merge(IntakeLive, ProposalsLive),
      Layer.provideMerge(
        Layer.mergeAll(
          RetrievalLive,
          ExecutorLive,
          SourcesLive.pipe(Layer.provide(makeObsidianCliTest().layer)),
        ),
        llm,
      ),
    ),
  );
  return { layer, issues, first: first.key, second: second.key, resolved, later };
}

const threadSteps = (inboxItemId: string) =>
  query((d) =>
    d
      .select()
      .from(proposals)
      .where(eq(proposals.inboxItemId, inboxItemId))
      .orderBy(asc(proposals.seq))
      .all(),
  );
const recordOf = (id: string) =>
  Effect.map(
    query((d) => d.select().from(bundles).where(eq(bundles.id, id)).get()),
    (b) => bundleRecordOf(b?.record),
  );
const blockersOf = (key: string) =>
  Effect.gen(function* () {
    const issue = yield* (yield* JiraClient).getIssue(key, { fields: ["issuelinks"] });
    return blockLinks(parseIssueLinks(issue.fields.issuelinks))
      .filter((l) => l.direction === "blockedBy")
      .map((l) => l.key);
  });

describe("playbooks against the mock Jira (FR-19.7 AC, Phase 26)", () => {
  test("waiting on Sarah: one card, approved; Blocked on; her 'done' resolves and un-blocks", async () => {
    const { layer, issues, first, second, resolved } = setup();
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sync = yield* Sync;
          const svc = yield* Proposals;
          yield* sync.run();
          // Sarah is on the Platform team, whose Jira project is PLAT (written by hand).
          yield* query((d) =>
            d.insert(teams).values({
              id: "t-platform",
              name: "Platform",
              jiraProjects: [{ key: "PLAT", by: "user" }],
            }),
          );
          yield* query((d) =>
            d.insert(people).values({
              id: "c-sarah",
              displayName: "Sarah Chen",
              jiraUsername: "sarah.c",
              teamId: "t-platform",
            }),
          );
          // A sync infers projects from synced tickets; the hand-written one stays.
          yield* sync.run();
          const team = yield* query((d) =>
            d.select().from(teams).where(eq(teams.id, "t-platform")).get(),
          );

          // 1. The chat.
          const stream = yield* (yield* Chat).stream({
            messages: ask("I'm waiting on Sarah for the cert"),
          });
          const chunks = yield* Effect.promise(() => drainStream(stream));
          const output = toolOutputs(chunks)[0] as {
            threadId: string;
            proposed: string[];
            playbooks?: { card: string; steps: string[] }[];
            note: string;
          };
          const steps = yield* threadSteps(output.threadId);
          const bundleId = steps[0]?.bundleId ?? "";
          const record = yield* recordOf(bundleId);
          const plat = yield* query((d) =>
            d.select().from(jiraIssues).where(eq(jiraIssues.key, "PLAT-812")).get(),
          );

          // 2. Approve the card as it is.
          const approved = yield* svc.approveBundle(
            bundleId,
            steps.map((p) => p.id),
          );
          const wait1 = yield* query((d) =>
            d.select().from(dependencies).where(eq(dependencies.issueKey, first)).get(),
          );
          const drafts = yield* query((d) => d.select().from(communications).all());
          const blockers1 = yield* blockersOf(first);

          // 3. Blocked on; the same on the second ticket, picking none of the found tickets.
          yield* (yield* Settings).update((s) => ({
            ...s,
            secretary: {
              ...s.secretary,
              instructions: { ...s.secretary.instructions, blockedStatus: true },
            },
          }));
          const t2 = yield* (yield* Intake).triage({
            text: `I'm waiting on Sarah for the payments cert on ${second}`,
            source: "typed",
            author: "chat",
            senderPersonId: null,
          });
          const steps2 = yield* threadSteps(t2.inboxItemId);
          const approved2 = yield* svc.approveBundle(
            steps2[0]?.bundleId ?? "",
            steps2.map((p) => p.id),
            {},
            { found: null },
          );
          const steps2After = yield* threadSteps(t2.inboxItemId);
          const wait2 = yield* query((d) =>
            d.select().from(dependencies).where(eq(dependencies.issueKey, second)).get(),
          );
          const blockedStatus = issues.get(second)?.status;
          const blockers2 = yield* blockersOf(second);
          const learned = yield* query((d) =>
            d.select().from(memories).where(eq(memories.subjectType, "work_item")).all(),
          );

          // 4. Sarah: it is done.
          resolved.text = JSON.stringify({
            summary: "Sarah says the payments cert is done",
            question: null,
            confidence: 0.9,
            proposals: [
              {
                kind: "update_dependency",
                dependencyId: wait2?.id ?? "",
                waitAction: "resolve",
                reply: "The payments cert is done",
                ...e,
              },
            ],
          });
          const t3 = yield* (yield* Intake).triage({
            text: `${second}: the payments cert is done, go ahead.`,
            source: "teams",
            senderPersonId: "c-sarah",
          });
          const steps3 = yield* threadSteps(t3.inboxItemId);
          const record3 = yield* recordOf(steps3[0]?.bundleId ?? "");
          const approved3 = yield* (yield* Proposals).approveAll(t3.inboxItemId);
          const wait2After = yield* query((d) =>
            d
              .select()
              .from(dependencies)
              .where(eq(dependencies.id, wait2?.id ?? ""))
              .get(),
          );
          const woke = yield* query((d) =>
            d.select().from(issueMeta).where(eq(issueMeta.issueKey, second)).get(),
          );
          return {
            team,
            output,
            steps,
            record,
            plat,
            approved,
            wait1,
            drafts,
            blockers1,
            steps2,
            approved2,
            steps2After,
            wait2,
            blockedStatus,
            blockers2,
            learned,
            steps3,
            record3,
            approved3,
            wait2After,
            woke,
          };
        }),
        layer,
      ),
    );

    // The team keeps its hand-written project through a sync.
    expect(r.team?.jiraProjects).toEqual([{ key: "PLAT", by: "user" }]);

    // 1. One card: the wait, their ticket (pre-selected), the comment, the request; no Blocked.
    expect(r.steps.map((p) => p.kind)).toEqual([
      "link_dependency",
      "link_issues",
      "add_comment",
      "draft_message",
    ]);
    expect(new Set(r.steps.map((p) => p.bundleId)).size).toBe(1);
    expect(r.steps.every((p) => p.bundleKind === "waiting_on_someone")).toBe(true);
    expect(r.record?.rule).toBe("waiting_on_someone");
    expect(r.record?.found).toMatchObject({ projects: ["PLAT"], picked: "PLAT-812", error: null });
    expect(r.record?.found?.results.map((x) => x.key)).toEqual(["PLAT-812"]);
    // Found tickets are candidates out of scope (D45), never synced tickets.
    expect(r.plat?.stale).toBe(true);
    expect(r.steps[0]?.payload).toMatchObject({
      target: first,
      ownerPersonId: "c-sarah",
      mirror: true,
      externalRef: "PLAT-812",
    });
    expect(r.steps[1]?.payload).toMatchObject({ kind: "link_issues", blocker: "PLAT-812" });
    expect((r.steps[2]?.payload as { bodyMd?: string } | undefined)?.bodyMd).toBe(
      "Waiting on Sarah Chen for the payments cert, see PLAT-812.",
    );
    expect(r.steps[3]?.payload).toMatchObject({ intent: "request", recipientPersonId: "c-sarah" });
    // The chat names the steps it offered.
    expect(r.output.playbooks?.[0]?.steps).toHaveLength(4);
    expect(r.output.note).toContain("name its steps");

    // 2. Approved: the link, the comment and the remote link are on the mock.
    expect(r.approved.map((x) => x.status)).toEqual([
      "executed",
      "executed",
      "executed",
      "executed",
    ]);
    expect(r.blockers1).toContain("PLAT-812");
    expect(r.wait1).toMatchObject({ externalRef: "PLAT-812", ownerPersonId: "c-sarah" });
    expect(r.wait1?.nextFollowupAt).not.toBeNull();
    expect(r.wait1?.mirrorRemoteLinkId).not.toBeNull();
    expect(r.drafts.map((c) => c.intent)).toEqual(["request"]);

    // 3. Blocked on: the move is a step; "None of these" skips the link with no correction.
    expect(r.steps2.map((p) => p.kind)).toEqual([
      "link_dependency",
      "link_issues",
      "add_comment",
      "transition_issue",
      "draft_message",
    ]);
    expect(r.steps2[3]?.payload).toMatchObject({ toStatus: "Blocked" });
    expect(r.approved2.map((x) => x.status)).toEqual([
      "executed",
      "executed",
      "executed",
      "executed",
    ]);
    expect(r.steps2After.find((p) => p.kind === "link_issues")?.status).toBe("rejected");
    expect(r.blockers2).toEqual([]);
    expect(r.blockedStatus).toBe("Blocked");
    expect(r.wait2?.externalRef).toBeNull();
    expect(r.wait2?.data).toEqual({
      blocked: { issueKey: second, from: "In Progress", to: "Blocked" },
    });
    expect(r.learned).toEqual([]);

    // 4. Her "done": resolve, say so, move back out of Blocked, and wake the ticket.
    expect(r.record3?.rule).toBe("wait_resolved");
    expect(r.steps3.map((p) => p.kind)).toEqual([
      "update_dependency",
      "add_comment",
      "transition_issue",
    ]);
    expect(r.approved3.map((x) => x.status)).toEqual(["executed", "executed", "executed"]);
    expect(r.wait2After?.status).toBe("resolved");
    expect(issues.get(second)?.status).toBe("In Progress");
    expect(issues.get(second)?.comments.at(-1)?.body).toContain(
      "No longer waiting on Sarah Chen for the payments cert",
    );
    expect(r.woke?.unblockedAt).not.toBeNull();
    expect(r.woke?.unblockedBy).toBe("wait:Sarah Chen delivered the payments cert");

    // The first ticket shows the comment and the remote link on the mock.
    const pay = issues.get(first);
    expect(pay?.comments.at(-1)?.body).toContain("Waiting on Sarah Chen for the payments cert");
    expect(pay?.remoteLinks?.some((l) => l.object.url.endsWith("/browse/PLAT-812"))).toBe(true);
  }, 30_000);
});

describe("a ticket that waits on two things (Phase 26 review)", () => {
  test("steps approved one by one keep the bookkeeping; the move back waits for the last wait and checks Jira", async () => {
    const resolveOut = (dependencyId: string) =>
      JSON.stringify({
        summary: "Sarah says it is done",
        question: null,
        confidence: 0.9,
        proposals: [
          {
            kind: "update_dependency",
            dependencyId,
            waitAction: "resolve",
            reply: "It is done",
            ...e,
          },
        ],
      });
    const { layer, issues, first, later } = setup(({ first }, later) => [
      out(answer([waitOn(first)])),
      ...later,
    ]);
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sync = yield* Sync;
          const svc = yield* Proposals;
          const intake = yield* Intake;
          yield* sync.run();
          yield* query((d) =>
            d.insert(teams).values({
              id: "t-platform",
              name: "Platform",
              jiraProjects: [{ key: "PLAT", by: "user" }],
            }),
          );
          yield* query((d) =>
            d.insert(people).values({
              id: "c-sarah",
              displayName: "Sarah Chen",
              jiraUsername: "sarah.c",
              teamId: "t-platform",
            }),
          );
          yield* (yield* Settings).update((s) => ({
            ...s,
            secretary: {
              ...s.secretary,
              instructions: { ...s.secretary.instructions, blockedStatus: true },
            },
          }));
          const t = yield* intake.triage({
            text: `I'm waiting on Sarah for the payments cert on ${first}`,
            source: "typed",
            author: "chat",
            senderPersonId: null,
          });
          const steps = yield* threadSteps(t.inboxItemId);
          // One by one, as Retry does: the wait, then the Blocked move.
          const wait = steps.find((p) => p.kind === "link_dependency");
          const move = steps.find((p) => p.kind === "transition_issue");
          yield* svc.approve(wait?.id ?? "");
          yield* svc.approve(move?.id ?? "");
          const w1 = yield* query((d) =>
            d.select().from(dependencies).where(eq(dependencies.issueKey, first)).get(),
          );
          // A second wait on the same ticket, still open.
          yield* query((d) =>
            d.insert(dependencies).values({
              id: "w-other",
              issueKey: first,
              kind: "team",
              label: "the load balancer slot",
              ownerTeamId: "t-platform",
              status: "waiting",
              requestedAt: new Date().toISOString(),
            }),
          );

          // Sarah: the cert is done. Another wait is open, so no move back and no wake.
          if (later[0]) later[0].text = resolveOut(w1?.id ?? "");
          const t2 = yield* intake.triage({
            text: `${first}: the payments cert is done.`,
            source: "teams",
            senderPersonId: "c-sarah",
          });
          const steps2 = yield* threadSteps(t2.inboxItemId);
          yield* svc.approveAll(t2.inboxItemId);
          const other = yield* query((d) =>
            d.select().from(dependencies).where(eq(dependencies.id, "w-other")).get(),
          );
          const w1After = yield* query((d) =>
            d
              .select()
              .from(dependencies)
              .where(eq(dependencies.id, w1?.id ?? ""))
              .get(),
          );
          const meta = yield* query((d) =>
            d.select().from(issueMeta).where(eq(issueMeta.issueKey, first)).get(),
          );

          // Someone moved the ticket on in Jira; the last wait's move back leaves it there.
          const pay = issues.get(first);
          if (pay) Object.assign(pay, { status: "In Review", updated: jiraNow() });
          if (later[1]) later[1].text = resolveOut("w-other");
          const t3 = yield* intake.triage({
            text: `${first}: the load balancer slot is done too.`,
            source: "teams",
            senderPersonId: "c-sarah",
          });
          const steps3 = yield* threadSteps(t3.inboxItemId);
          yield* svc.approveAll(t3.inboxItemId);
          const steps3After = yield* threadSteps(t3.inboxItemId);
          return { w1, steps2, other, w1After, meta, steps3, steps3After };
        }),
        layer,
      ),
    );
    // Approved one at a time, the Blocked move is still remembered on the wait.
    expect(r.w1?.data).toEqual({
      blocked: { issueKey: first, from: "In Progress", to: "Blocked" },
    });
    // With another wait open: resolve and comment only; that wait takes the memory.
    expect(r.steps2.map((p) => p.kind)).toEqual(["update_dependency", "add_comment"]);
    expect(r.w1After?.status).toBe("resolved");
    expect(r.w1After?.data?.blocked).toBeUndefined();
    expect(r.other?.data).toEqual({
      blocked: { issueKey: first, from: "In Progress", to: "Blocked" },
    });
    expect(r.meta?.unblockedAt ?? null).toBeNull();
    expect(issues.get(first)?.status).toBe("In Review");
    // The last wait's card offers the move back, which Jira's status now skips.
    expect(r.steps3.map((p) => p.kind)).toEqual([
      "update_dependency",
      "add_comment",
      "transition_issue",
    ]);
    const move = r.steps3After.find((p) => p.kind === "transition_issue");
    expect(move?.status).toBe("rejected");
    expect((move?.result as { reason?: string } | null)?.reason).toContain("is in In Review now");
  }, 30_000);
});

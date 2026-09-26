import { describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { dependencies, inboxItems, intakeItems, memories, proposals } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { query } from "@/services/db";
import { ExecutorLive } from "@/services/executor/live";
import issueTypes from "@/test/fixtures/jira/createmeta-PAY-issuetypes.json";
import createFields from "@/test/fixtures/jira/createmeta-PAY-story.json";
import { fixtureIssues, syncedJiraLayer, syncOnce } from "@/test/seed";
import { json, noContent, type StubRoute } from "@/test/stub-fetch";
import { type ProposalError, type ProposalPayload, Proposals } from ".";
import { ProposalsLive } from "./live";

const pay4 = fixtureIssues.find((i) => i.key === "PAY-4");

const transitions = {
  transitions: [
    { id: "11", name: "Reopen", to: { name: "To Do", statusCategory: { key: "new" } } },
    { id: "31", name: "Resolve", to: { name: "Done", statusCategory: { key: "done" } } },
  ],
};

function setup(opts: { createStatus?: number; requiredExtra?: boolean } = {}) {
  const routes: StubRoute[] = [
    {
      match: (u) => u.pathname.endsWith("/createmeta/PAY/issuetypes"),
      respond: () => json(issueTypes),
    },
    {
      match: (u) => /\/createmeta\/PAY\/issuetypes\/\d+$/.test(u.pathname),
      respond: () =>
        json(
          opts.requiredExtra
            ? {
                ...createFields,
                values: [
                  ...createFields.values,
                  {
                    required: true,
                    name: "Team",
                    fieldId: "customfield_12000",
                    hasDefaultValue: false,
                    operations: ["set"],
                  },
                ],
              }
            : createFields,
        ),
    },
    {
      match: (u, r) => u.pathname.endsWith("/rest/api/2/issue") && r.method === "POST",
      respond: () =>
        opts.createStatus
          ? json(
              { errorMessages: [], errors: { summary: "Summary is too long" } },
              opts.createStatus,
            )
          : json({ id: "20099", key: "PAY-5" }, 201),
    },
    {
      match: (u) => u.pathname.endsWith("/issue/PAY-5"),
      respond: () => json({ ...pay4, id: "20099", key: "PAY-5" }),
    },
    {
      match: (u, r) => u.pathname.endsWith("/transitions") && r.method === "GET",
      respond: () => json(transitions),
    },
    {
      match: (u, r) => u.pathname.endsWith("/transitions") && r.method === "POST",
      respond: () => noContent(),
    },
    {
      match: (u, r) => u.pathname.endsWith("/comment") && r.method === "POST",
      respond: () =>
        json(
          {
            id: "1",
            body: "x",
            created: "2026-09-24T10:00:00.000+0100",
            updated: "2026-09-24T10:00:00.000+0100",
          },
          201,
        ),
    },
  ];
  const jira = syncedJiraLayer(routes);
  const layer = Layer.provideMerge(ProposalsLive, Layer.provideMerge(ExecutorLive, jira.layer));
  return { layer, seen: jira.seen };
}

/** Inserts an inbox item with one intake item and the given proposals (seq in order). */
const seed = (payloads: ProposalPayload[]) =>
  Effect.gen(function* () {
    const inboxItemId = newId();
    const intakeItemId = newId();
    yield* query((d) =>
      d.insert(inboxItems).values({
        id: inboxItemId,
        source: "teams",
        rawText: "raw",
        receivedAt: nowIso(),
        status: "triaged",
      }),
    );
    yield* query((d) =>
      d.insert(intakeItems).values({
        id: intakeItemId,
        inboxItemId,
        idx: 0,
        quote: "Refunds need a backfill story; PAY-2 waits on INC0012345",
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
          evidence: "evidence",
          confidence: 0.9,
          status: "pending" as const,
          createdAt: nowIso(),
        })),
      ),
    );
    return { inboxItemId, ids };
  });

const rowsOf = (inboxItemId: string) =>
  query((d) =>
    d
      .select()
      .from(proposals)
      .where(eq(proposals.inboxItemId, inboxItemId))
      .orderBy(asc(proposals.seq))
      .all(),
  );

const create: ProposalPayload = {
  kind: "create_issue",
  ref: "$new:1",
  projectKey: "PAY",
  issueType: "Story",
  summary: "Backfill August refund totals",
  descriptionMd: "**Why:** finance asked",
  parent: null,
  epic: "PAY-1",
  priority: null,
  assignee: null,
  dueDate: null,
};

describe("Proposals", () => {
  test("approve all executes in order, resolving $new refs, and files the inbox item", async () => {
    const { layer, seen } = setup();
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const { inboxItemId } = yield* seed([
            create,
            { kind: "add_comment", target: "$new:1", bodyMd: "Created from **triage**" },
            {
              kind: "link_dependency",
              target: "PAY-2",
              dependencyKind: "incident",
              label: "Platform incident",
              ownerPersonId: null,
              ownerTeamId: null,
              externalRef: "INC0012345",
              externalUrl: null,
              expectedAt: "2026-09-30",
              nextFollowupAt: null,
            },
            {
              kind: "remember",
              memoryKind: "rule",
              content: "Refund work goes under PAY-1",
              subjectType: null,
              subjectId: null,
            },
            { kind: "transition_issue", target: "PAY-2", toStatus: "To Do" },
          ]);
          const results = yield* (yield* Proposals).approveAll(inboxItemId);
          return {
            results,
            rows: yield* rowsOf(inboxItemId),
            inbox: yield* query((d) =>
              d.select().from(inboxItems).where(eq(inboxItems.id, inboxItemId)).get(),
            ),
            deps: yield* query((d) => d.select().from(dependencies).all()),
            mems: yield* query((d) => d.select().from(memories).all()),
          };
        }),
        layer,
      ),
    );
    expect(r.results.map((x) => x.status)).toEqual([
      "executed",
      "executed",
      "executed",
      "executed",
      "executed",
    ]);
    expect(r.results[0]).toMatchObject({ message: "Created PAY-5", issueKey: "PAY-5" });
    expect(r.rows.every((x) => x.status === "executed")).toBe(true);
    expect(r.inbox?.status).toBe("filed");

    const post = seen.find((s) => s.method === "POST" && s.url.endsWith("/rest/api/2/issue"));
    expect(post?.body).toEqual({
      fields: {
        project: { key: "PAY" },
        issuetype: { id: "10001" },
        summary: "Backfill August refund totals",
        description: "*Why:* finance asked",
        customfield_10100: "PAY-1",
      },
    });
    const comment = seen.find((s) => s.method === "POST" && s.url.endsWith("/issue/PAY-5/comment"));
    expect(comment?.body).toEqual({ body: "Created from *triage*" });
    expect(
      seen.find((s) => s.method === "POST" && s.url.endsWith("/issue/PAY-2/transitions"))?.body,
    ).toEqual({ transition: { id: "11" } });
    expect(r.deps[0]).toMatchObject({
      issueKey: "PAY-2",
      kind: "incident",
      externalRef: "INC0012345",
      status: "open",
      expectedAt: "2026-09-30",
    });
    expect(r.mems[0]).toMatchObject({
      kind: "rule",
      source: "inferred",
      confirmed: true,
      content: "Refund work goes under PAY-1",
    });
  });

  test("a failed create fails its dependants but not unrelated proposals", async () => {
    const { layer } = setup({ createStatus: 400 });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const { inboxItemId } = yield* seed([
            create,
            { kind: "add_comment", target: "$new:1", bodyMd: "depends" },
            { kind: "transition_issue", target: "PAY-2", toStatus: "Done" },
          ]);
          return {
            results: yield* (yield* Proposals).approveAll(inboxItemId),
            rows: yield* rowsOf(inboxItemId),
          };
        }),
        layer,
      ),
    );
    expect(r.results.map((x) => x.status)).toEqual(["failed", "failed", "executed"]);
    expect(r.results[0]?.message).toContain("summary: Summary is too long");
    expect(r.results[1]?.message).toContain("Approve the new issue $new:1 first");
  });

  test("rejecting records a correction example with the item's input", async () => {
    const { layer } = setup();
    const mem = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const { ids } = yield* seed([
            { kind: "transition_issue", target: "PAY-2", toStatus: "Done" },
          ]);
          yield* (yield* Proposals).reject(ids[0] ?? "");
          return yield* query((d) => d.select().from(memories).all());
        }),
        layer,
      ),
    );
    expect(mem[0]).toMatchObject({
      kind: "example",
      subjectId: "transition_issue",
      content: "Rejected: Move PAY-2 to Done",
      exampleInput: "Refunds need a backfill story; PAY-2 waits on INC0012345",
      exampleAfter: null,
      source: "user",
    });
  });

  test("an edit before approval is executed and recorded as a correction", async () => {
    const { layer, seen } = setup();
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const { ids, inboxItemId } = yield* seed([
            { kind: "transition_issue", target: "PAY-2", toStatus: "Done" },
          ]);
          const result = yield* (yield* Proposals).approve(ids[0] ?? "", {
            kind: "transition_issue",
            target: "PAY-2",
            toStatus: "To Do",
          });
          return {
            result,
            rows: yield* rowsOf(inboxItemId),
            mems: yield* query((d) => d.select().from(memories).all()),
          };
        }),
        layer,
      ),
    );
    expect(r.result.status).toBe("executed");
    expect(r.rows[0]?.editedPayload).toEqual({
      kind: "transition_issue",
      target: "PAY-2",
      toStatus: "To Do",
    });
    expect(seen.find((s) => s.method === "POST" && s.url.endsWith("/transitions"))?.body).toEqual({
      transition: { id: "11" },
    });
    expect(r.mems[0]).toMatchObject({
      content: "Changed: Move PAY-2 to Done -> Move PAY-2 to To Do",
    });
  });

  test("retrying a failed edited proposal runs the edit again", async () => {
    const { layer, seen } = setup({ createStatus: 400 });
    const edited: ProposalPayload = { ...create, summary: "Backfill refund totals for August" };
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const { ids, inboxItemId } = yield* seed([create]);
          const proposalsSvc = yield* Proposals;
          const first = yield* proposalsSvc.approve(ids[0] ?? "", edited);
          const retry = yield* proposalsSvc.approve(ids[0] ?? "");
          return {
            first,
            retry,
            rows: yield* rowsOf(inboxItemId),
            mems: yield* query((d) => d.select().from(memories).all()),
          };
        }),
        layer,
      ),
    );
    expect([r.first.status, r.retry.status]).toEqual(["failed", "failed"]);
    const posts = seen.filter((s) => s.method === "POST" && s.url.endsWith("/rest/api/2/issue"));
    expect(posts.map((s) => (s.body as { fields: { summary: string } }).fields.summary)).toEqual([
      "Backfill refund totals for August",
      "Backfill refund totals for August",
    ]);
    expect(r.rows[0]?.editedPayload).toEqual(edited);
    // The edit is one correction, not one per attempt.
    expect(r.mems.filter((m) => m.kind === "example")).toHaveLength(1);
  });

  test("missing required create fields fail before anything is sent", async () => {
    const { layer, seen } = setup({ requiredExtra: true });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const { ids } = yield* seed([create]);
          return yield* (yield* Proposals).approve(ids[0] ?? "");
        }),
        layer,
      ),
    );
    expect(r.status).toBe("failed");
    expect(r.message).toContain("Jira requires Team for a Story in PAY");
    expect(seen.some((s) => s.method === "POST" && s.url.endsWith("/rest/api/2/issue"))).toBe(
      false,
    );
  });

  test("impossible transitions and questions are refused clearly", async () => {
    const { layer } = setup();
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const { ids } = yield* seed([
            { kind: "transition_issue", target: "PAY-2", toStatus: "In Review" },
            { kind: "needs_clarification", question: "Which ticket?" },
          ]);
          const proposalsSvc = yield* Proposals;
          const transition = yield* proposalsSvc.approve(ids[0] ?? "");
          const question = yield* Effect.either(proposalsSvc.approve(ids[1] ?? ""));
          const again = yield* Effect.either(proposalsSvc.reject(ids[0] ?? ""));
          return { transition, question, again };
        }),
        layer,
      ),
    );
    expect(r.transition.message).toContain(
      "cannot move to In Review from its current status (available: To Do, Done)",
    );
    expect(r.question._tag === "Left" && (r.question.left as ProposalError).kind).toBe("invalid");
    // A failed proposal can be retried with approve but not rejected into a correction.
    expect(r.again._tag === "Left" && (r.again.left as ProposalError).kind).toBe("decided");
  });
});

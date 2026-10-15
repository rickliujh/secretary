import { describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { fromFormValues, toFormValues } from "@/components/inbox/proposal-fields";
import { dependencies, inboxItems, intakeItems, memories, proposals } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { query } from "@/services/db";
import { ExecutorLive } from "@/services/executor/live";
import { inboxDetail } from "@/services/inbox/queries";
import issueTypes from "@/test/fixtures/jira/createmeta-PAY-issuetypes.json";
import createFields from "@/test/fixtures/jira/createmeta-PAY-story.json";
import { fixtureIssues, syncedJiraLayer, syncOnce } from "@/test/seed";
import { json, noContent, type StubRoute } from "@/test/stub-fetch";
import {
  CreateIssue,
  type ProposalError,
  ProposalPayloadSchema,
  Proposals,
  type StoredProposalPayload,
} from ".";
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
      // Fresh reads of a fixture issue, such as the values an update replaces (D54).
      match: (u, r) => /\/issue\/[A-Z]+-\d+$/.test(u.pathname) && r.method === "GET",
      respond: (r) => {
        const issue = fixtureIssues.find((i) => r.url.pathname.endsWith(`/issue/${i.key}`));
        return issue ? json(issue) : json({ errorMessages: ["Issue Does Not Exist"] }, 404);
      },
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
const seed = (payloads: StoredProposalPayload[]) =>
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

/** Stored before Phase 11: no labels, smallAsk, requesterPersonId or joinSprint. */
const create: StoredProposalPayload = {
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
    const edited = ProposalPayloadSchema.parse({
      ...create,
      summary: "Backfill refund totals for August",
    });
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

  test("a create_issue stored before small asks still loads, edits and executes", async () => {
    const { layer, seen } = setup();
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const { ids, inboxItemId } = yield* seed([create]);
          // Loads: the Inbox sees the new fields with their defaults.
          const loaded = (yield* inboxDetail(inboxItemId))?.proposals[0]?.payload;
          if (!loaded) throw new Error("not loaded");
          // Edits: the edit form round-trips it into a valid payload.
          const values = { ...toFormValues(loaded), summary: "Backfill refund totals" };
          const edited = ProposalPayloadSchema.parse(fromFormValues(loaded, values));
          // Executes.
          const result = yield* (yield* Proposals).approve(ids[0] ?? "", edited);
          return { loaded, edited, result, rows: yield* rowsOf(inboxItemId) };
        }),
        layer,
      ),
    );
    expect(r.loaded).toMatchObject({
      kind: "create_issue",
      labels: [],
      smallAsk: false,
      requesterPersonId: null,
      joinSprint: false,
    });
    expect(r.edited).toMatchObject({ summary: "Backfill refund totals", labels: [] });
    expect(r.result).toMatchObject({ status: "executed", issueKey: "PAY-5" });
    const post = seen.find((x) => x.method === "POST" && x.url.endsWith("/rest/api/2/issue"));
    expect((post?.body as { fields?: object } | undefined)?.fields).toBeDefined();
    expect((post?.body as { fields?: object } | undefined)?.fields).not.toHaveProperty("labels");
    expect(r.rows[0]?.editedPayload).toMatchObject({ summary: "Backfill refund totals" });
  });

  test("approving a stored payload unchanged does not record the new defaults as an edit", async () => {
    const { layer } = setup();
    const rows = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const { ids, inboxItemId } = yield* seed([create]);
          yield* (yield* Proposals).approve(ids[0] ?? "");
          return yield* rowsOf(inboxItemId);
        }),
        layer,
      ),
    );
    expect(rows[0]?.status).toBe("executed");
    expect(rows[0]?.editedPayload).toBeNull();
  });

  test("Track approves the bundle in order, recording the row's change as an edit (D44)", async () => {
    const { layer, seen } = setup();
    const ask = { ...create, epic: null, labels: ["small-ask"], smallAsk: true };
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const { ids, inboxItemId } = yield* seed([
            ask,
            { kind: "add_comment", target: "$new:1", bodyMd: "Asked on Teams" },
          ]);
          const edited = ProposalPayloadSchema.parse({ ...ask, epic: "PAY-1" });
          const results = yield* (yield* Proposals).track(ids, { [ids[0] ?? ""]: edited });
          return {
            results,
            rows: yield* rowsOf(inboxItemId),
            mems: yield* query((d) => d.select().from(memories).all()),
          };
        }),
        layer,
      ),
    );
    expect(r.results.map((x) => x.status)).toEqual(["executed", "executed"]);
    expect(r.rows[0]?.editedPayload).toMatchObject({ epic: "PAY-1" });
    expect(r.mems[0]?.content).toContain("Changed:");
    const post = seen.find((x) => x.method === "POST" && x.url.endsWith("/rest/api/2/issue"));
    expect((post?.body as { fields?: object } | undefined)?.fields).toMatchObject({
      customfield_10100: "PAY-1",
    });
    expect(seen.some((x) => x.method === "POST" && x.url.endsWith("/issue/PAY-5/comment"))).toBe(
      true,
    );
  });

  test("a row change saved before approval is what its card's Approve runs (D44)", async () => {
    const { layer, seen } = setup();
    const ask = { ...create, epic: null, labels: ["small-ask"], smallAsk: true };
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const { ids, inboxItemId } = yield* seed([ask]);
          const svc = yield* Proposals;
          const id = ids[0] ?? "";
          yield* svc.saveEdit(
            id,
            ProposalPayloadSchema.parse({ ...ask, issueType: "Bug", epic: "PAY-1" }),
          );
          const saved = (yield* rowsOf(inboxItemId))[0];
          const memsBefore = yield* query((d) => d.select().from(memories).all());
          // The card's Approve sends no edit of its own.
          const result = yield* svc.approve(id);
          return {
            saved,
            memsBefore,
            result,
            mems: yield* query((d) => d.select().from(memories).all()),
          };
        }),
        layer,
      ),
    );
    expect(r.saved?.status).toBe("pending");
    expect(r.saved?.editedPayload).toMatchObject({ issueType: "Bug", epic: "PAY-1" });
    // Saving records nothing; the approval records the change once.
    expect(r.memsBefore).toHaveLength(0);
    expect(r.result.status).toBe("executed");
    expect(r.mems.filter((m) => m.kind === "example")).toHaveLength(1);
    const post = seen.find((x) => x.method === "POST" && x.url.endsWith("/rest/api/2/issue"));
    const fields = (post?.body as { fields?: Record<string, unknown> } | undefined)?.fields;
    expect(fields).toMatchObject({ customfield_10100: "PAY-1" });
    expect((fields?.issuetype as { id?: string } | undefined)?.id).toBe(
      issueTypes.values.find((t) => t.name === "Bug")?.id,
    );
  });

  test("the sprint switch is no correction; an edit with it leaves it out (D57)", async () => {
    const { layer } = setup();
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const { ids } = yield* seed([create, create]);
          const svc = yield* Proposals;
          const [a = "", b = ""] = ids;
          const switched = CreateIssue.parse({
            ...create,
            joinSprint: true,
            joinSprintChosen: true,
          });
          yield* svc.saveEdit(a, switched);
          yield* svc.approve(a);
          const memsAfterSwitch = yield* query((d) => d.select().from(memories).all());
          yield* svc.approve(b, { ...switched, summary: "Backfill the refund totals" });
          return { memsAfterSwitch, mems: yield* query((d) => d.select().from(memories).all()) };
        }),
        layer,
      ),
    );
    expect(r.memsAfterSwitch.filter((m) => m.kind === "example")).toHaveLength(0);
    const examples = r.mems.filter((m) => m.kind === "example");
    expect(examples).toHaveLength(1);
    expect(examples[0]?.exampleAfter).toMatchObject({ summary: "Backfill the refund totals" });
    expect(examples[0]?.exampleAfter).not.toHaveProperty("joinSprint");
    expect(examples[0]?.exampleBefore).not.toHaveProperty("joinSprintChosen");
  });

  test("Track after a saved change records it once; saving the original clears it", async () => {
    const { layer } = setup();
    const ask = { ...create, epic: null, labels: ["small-ask"], smallAsk: true };
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const { ids, inboxItemId } = yield* seed([ask, ask]);
          const svc = yield* Proposals;
          const [a = "", b = ""] = ids;
          const edited = ProposalPayloadSchema.parse({ ...ask, epic: "PAY-1" });
          // The row saves the change, then Track sends the same change again.
          yield* svc.saveEdit(a, edited);
          yield* svc.track([a], { [a]: edited });
          // Picking a change and then going back to the proposal leaves no edit.
          yield* svc.saveEdit(b, edited);
          yield* svc.saveEdit(b, ProposalPayloadSchema.parse(ask));
          const cleared = (yield* rowsOf(inboxItemId))[1];
          yield* svc.approve(b);
          const refused = yield* Effect.flip(svc.saveEdit(b, edited));
          return {
            cleared,
            refused,
            mems: yield* query((d) => d.select().from(memories).all()),
          };
        }),
        layer,
      ),
    );
    expect(r.cleared?.editedPayload).toBeNull();
    expect(r.mems.filter((m) => m.kind === "example")).toHaveLength(1);
    expect((r.refused as ProposalError).kind).toBe("decided");
  });

  test("Track stops when the create fails, leaving what hangs on it pending", async () => {
    const { layer } = setup({ createStatus: 400 });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const { ids, inboxItemId } = yield* seed([
            { ...create, smallAsk: true },
            { kind: "add_comment", target: "$new:1", bodyMd: "Asked on Teams" },
          ]);
          const results = yield* (yield* Proposals).track(ids);
          return { results, rows: yield* rowsOf(inboxItemId) };
        }),
        layer,
      ),
    );
    expect(r.results.map((x) => x.status)).toEqual(["failed"]);
    expect(r.rows.map((x) => x.status)).toEqual(["failed", "pending"]);
  });
});

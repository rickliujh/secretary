/** Executing a small ask (D44): labels, requester, and joining the active sprint. */
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { inboxItems, issueMeta, jiraIssues, proposals } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { type Db, query } from "@/services/db";
import { Proposals, type StoredProposalPayload } from "@/services/proposals";
import { ProposalsLive } from "@/services/proposals/live";
import { fixtureIssues, syncedJiraLayer, syncOnce } from "@/test/seed";
import { json, noContent, type StubRoute } from "@/test/stub-fetch";
import { ExecutorLive } from "./live";

const pay4 = fixtureIssues.find((i) => i.key === "PAY-4");

const fields = ["project", "issuetype", "summary", "description", "assignee", "duedate", "labels"];

function setup(opts: { sprintMove?: number } = {}) {
  const routes: StubRoute[] = [
    {
      match: (u) => u.pathname.endsWith("/createmeta/PAY/issuetypes"),
      respond: () =>
        json({
          values: [
            { id: "3", name: "Task", subtask: false },
            { id: "5", name: "Sub-task", subtask: true },
          ],
        }),
    },
    {
      match: (u) => /\/createmeta\/PAY\/issuetypes\/\d+$/.test(u.pathname),
      respond: (r) =>
        json({
          values: [
            ...fields.map((fieldId) => ({ fieldId, name: fieldId, required: false })),
            ...(r.url.pathname.endsWith("/5")
              ? [{ fieldId: "parent", name: "Parent", required: true }]
              : []),
          ],
        }),
    },
    {
      match: (u, r) => u.pathname.endsWith("/rest/api/2/issue") && r.method === "POST",
      respond: () => json({ id: "20099", key: "PAY-5" }, 201),
    },
    {
      match: (u) => u.pathname.endsWith("/issue/PAY-5"),
      respond: () => json({ ...pay4, id: "20099", key: "PAY-5" }),
    },
    {
      match: (u, r) => u.pathname === "/rest/agile/1.0/sprint/42/issue" && r.method === "POST",
      respond: () =>
        opts.sprintMove
          ? json({ errorMessages: ["Issue is not on the board"] }, opts.sprintMove)
          : noContent(),
    },
  ];
  const jira = syncedJiraLayer(routes);
  return {
    layer: Layer.provideMerge(ProposalsLive, Layer.provideMerge(ExecutorLive, jira.layer)),
    seen: jira.seen,
  };
}

const smallAsk: StoredProposalPayload = {
  kind: "create_issue",
  ref: "$new:1",
  projectKey: "PAY",
  issueType: "Task",
  summary: "Send Dana the Q3 numbers",
  descriptionMd:
    "_Asked by Dana Reyes via Teams on 2026-09-24:_\n\n> can you send me the Q3 numbers?",
  assignee: "rliu",
  dueDate: "2026-09-25",
  labels: ["small-ask"],
  smallAsk: true,
  requesterPersonId: "p-dana",
  joinSprint: true,
};

/** Approves one proposal; `mine` puts the user's PAY-4 into the active sprint first. */
const approve = (
  payload: StoredProposalPayload,
  mine = true,
  before: Effect.Effect<unknown, unknown, Db> = Effect.void,
) =>
  Effect.gen(function* () {
    yield* syncOnce;
    yield* before.pipe(Effect.orDie);
    if (mine)
      yield* query((d) =>
        d.update(jiraIssues).set({ sprint: "Payments 15" }).where(eq(jiraIssues.key, "PAY-4")),
      );
    const inboxItemId = newId();
    const id = newId();
    yield* query((d) =>
      d.insert(inboxItems).values({
        id: inboxItemId,
        source: "teams",
        rawText: "can you send me the Q3 numbers?",
        receivedAt: nowIso(),
      }),
    );
    yield* query((d) =>
      d.insert(proposals).values({
        id,
        inboxItemId,
        seq: 0,
        kind: payload.kind,
        payload,
        status: "pending",
        createdAt: nowIso(),
      }),
    );
    const result = yield* (yield* Proposals).approve(id);
    const meta = yield* query((d) =>
      d.select().from(issueMeta).where(eq(issueMeta.issueKey, "PAY-5")).get(),
    ).pipe(Effect.orElseSucceed(() => undefined));
    const row = yield* query((d) => d.select().from(proposals).where(eq(proposals.id, id)).get());
    return { result, meta, row };
  });

describe("executing a small ask (D44)", () => {
  test("creates with the label, records who asked and joins the user's active sprint", async () => {
    const { layer, seen } = setup();
    const r = await Effect.runPromise(Effect.provide(approve(smallAsk), layer));
    expect(r.result).toEqual({
      status: "executed",
      message: "Created PAY-5 in sprint Payments 15",
      issueKey: "PAY-5",
    });
    const post = seen.find((x) => x.method === "POST" && x.url.endsWith("/rest/api/2/issue"));
    expect((post?.body as { fields?: object } | undefined)?.fields).toMatchObject({
      labels: ["small-ask"],
      assignee: { name: "rliu" },
      duedate: "2026-09-25",
    });
    const move = seen.find((x) => x.url.endsWith("/rest/agile/1.0/sprint/42/issue"));
    expect(move?.body).toEqual({ issues: ["PAY-5"] });
    expect(r.meta?.requesterPersonId).toBe("p-dana");
  });

  test("a failed sprint move leaves the proposal executed with a warning", async () => {
    const { layer } = setup({ sprintMove: 400 });
    const r = await Effect.runPromise(Effect.provide(approve(smallAsk), layer));
    expect(r.result.status).toBe("executed");
    expect(r.result.message).toBe("Created PAY-5");
    expect(r.result.warning).toContain("could not be moved into sprint Payments 15");
  });

  test("with none of the user's work in an active sprint it stays in the backlog, with a note", async () => {
    const { layer, seen } = setup();
    const r = await Effect.runPromise(Effect.provide(approve(smallAsk, false), layer));
    expect(r.result).toMatchObject({ status: "executed", message: "Created PAY-5" });
    expect(r.result.warning).toBe(
      "No active sprint holds your work, so PAY-5 stays in the backlog.",
    );
    expect(seen.some((x) => x.url.includes("/rest/agile/1.0/sprint/"))).toBe(false);
  });

  test("a sub-task is not moved: it follows its parent", async () => {
    const { layer, seen } = setup();
    const r = await Effect.runPromise(
      Effect.provide(
        approve({ ...smallAsk, issueType: "Sub-task", parent: "PAY-2", joinSprint: false }),
        layer,
      ),
    );
    expect(r.result).toMatchObject({ status: "executed", message: "Created PAY-5" });
    expect(r.result.warning).toBeUndefined();
    expect(seen.some((x) => x.url.includes("/rest/agile/1.0/sprint/"))).toBe(false);
  });

  const creates = (seen: { url: string; method: string }[]) =>
    seen.filter((x) => x.method === "POST" && x.url.endsWith("/rest/api/2/issue")).length;

  test("a failed epic link after the create is a warning on an executed proposal", async () => {
    const { layer, seen } = setup();
    // No Epic Link or parent on the create screen, so the epic is set afterwards,
    // and that edit fails (no edit metadata).
    const r = await Effect.runPromise(
      Effect.provide(approve({ ...smallAsk, epic: "PAY-1" }), layer),
    );
    expect(r.result.status).toBe("executed");
    expect(r.result.issueKey).toBe("PAY-5");
    expect(r.result.warning).toContain("PAY-5 was created, but linking it to epic PAY-1 failed");
    expect(r.row?.status).toBe("executed");
    // The sprint move after it still ran, and nothing is left to retry.
    expect(r.result.message).toBe("Created PAY-5 in sprint Payments 15");
    expect(creates(seen)).toBe(1);
  });

  test("a failed local write after the create is a warning too, not a failure", async () => {
    const { layer, seen } = setup();
    const r = await Effect.runPromise(
      Effect.provide(
        approve(
          smallAsk,
          true,
          query((d) => d.run(sql`DROP TABLE issue_meta`)),
        ),
        layer,
      ),
    );
    expect(r.result).toMatchObject({ status: "executed", issueKey: "PAY-5" });
    expect(r.result.warning).toContain("PAY-5 was created, but remembering who asked failed");
    expect(creates(seen)).toBe(1);
  });
});

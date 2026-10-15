/** Retrying a change to a wait (D46): the timeline entry is written once. */
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { proposals } from "@/db/schema";
import { type Db, query } from "@/services/db";
import { createDependency, getDependency, logFollowup } from "@/services/dependencies/queries";
import { Executor } from "@/services/executor";
import { ExecutorLive } from "@/services/executor/live";
import { ProposalPayloadSchema } from "@/services/proposals/schema";
import type { Settings } from "@/services/settings";
import { syncedJiraLayer } from "@/test/seed";

const run = (
  payload: Record<string, unknown>,
  opts: {
    times?: number;
    createdAt?: string;
    before?: (id: string) => Effect.Effect<unknown, unknown, Db | Executor | Settings>;
  } = {},
) => {
  const jira = syncedJiraLayer();
  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const id = yield* createDependency({
          issueKey: "PAY-2",
          kind: "external",
          label: "Vendor quote",
          expectedAt: "2026-09-30",
        });
        yield* query((d) =>
          d.insert(proposals).values({
            id: "u1",
            seq: 0,
            kind: "update_dependency",
            payload: {},
            status: "approved",
            createdAt: opts.createdAt ?? "2020-01-01T00:00:00.000Z",
          }),
        );
        if (opts.before) yield* Effect.orDie(opts.before(id));
        const results = [];
        for (let i = 0; i < (opts.times ?? 1); i++)
          results.push(
            yield* Effect.either(
              (yield* Executor).runProposal(
                ProposalPayloadSchema.parse({ ...payload, dependencyId: id }),
                { proposalId: "u1", inboxItemId: null },
              ),
            ),
          );
        return { results, after: yield* getDependency(id) };
      }),
      Layer.provideMerge(ExecutorLive, jira.layer),
    ),
  );
};

const base = { kind: "update_dependency", channel: "email" };

describe("a retried change to a wait (D46)", () => {
  test("a reply run twice is logged once, with the dates set", async () => {
    const r = await run(
      { ...base, action: "log_reply", summary: "Half now", nextFollowupAt: "2026-10-20" },
      { times: 2 },
    );
    expect(r.results.map((x) => x._tag)).toEqual(["Right", "Right"]);
    expect(r.after?.timeline.map((t) => t.summary)).toEqual(["Half now"]);
    expect(r.after?.dependency).toMatchObject({ status: "waiting", nextFollowupAt: "2026-10-20" });
  });

  test("a resolve whose entry was written before a later step failed resolves without a second", async () => {
    const r = await run(
      { ...base, action: "resolve", summary: "Quote arrived" },
      // The first attempt wrote the entry, then failed before setting the status.
      { before: (id) => logFollowup(id, { channel: "email", summary: "Quote arrived" }) },
    );
    expect(r.results[0]?._tag).toBe("Right");
    expect(r.after?.dependency).toMatchObject({ status: "resolved", nextFollowupAt: null });
    expect(r.after?.timeline.map((t) => t.summary)).toEqual(["Quote arrived"]);
  });

  test("the same words logged before the proposal was made are a separate entry", async () => {
    const r = await run(
      { ...base, action: "log_reply", summary: "Quote arrived" },
      {
        createdAt: "2999-01-01T00:00:00.000Z",
        before: (id) => logFollowup(id, { channel: "email", summary: "Quote arrived" }),
      },
    );
    expect(r.after?.timeline.map((t) => t.summary)).toEqual(["Quote arrived", "Quote arrived"]);
  });
});

/** link_issues in the Executor over the fixtures (D45): what happens without a blocks type. */
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { Executor } from "@/services/executor";
import { ExecutorLive } from "@/services/executor/live";
import { syncedJiraLayer, syncOnce } from "@/test/seed";

describe("link_issues without a blocks link type", () => {
  test("fails clearly and writes nothing", async () => {
    // The fixture Jira serves no /issueLinkType, so sync stores none.
    const { layer, seen } = syncedJiraLayer();
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          return yield* Effect.either(
            (yield* Executor).runProposal(
              { kind: "link_issues", target: "PAY-4", blocker: "PAY-2" },
              { proposalId: "p1", inboxItemId: null },
            ),
          );
        }),
        Layer.provideMerge(ExecutorLive, layer),
      ),
    );
    expect(r._tag).toBe("Left");
    if (r._tag === "Left") expect(r.left.message).toContain('no "blocks" link type');
    expect(seen.some((x) => x.url.includes("/issueLink") && x.method !== "GET")).toBe(false);
  });
});

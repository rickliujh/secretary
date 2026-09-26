import { describe, expect, test } from "bun:test";
import type { UIMessage, UIMessageChunk } from "ai";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { proposals } from "@/db/schema";
import { query } from "@/services/db";
import { createDependency } from "@/services/dependencies/queries";
import { createTeam } from "@/services/directory/queries";
import { drainStream, promptOf } from "@/test/helpers";
import { intakeTestLayer, out } from "@/test/intake-layer";
import { syncOnce } from "@/test/seed";
import { Chat } from ".";

const ask = (text: string): UIMessage[] => [
  { id: "u1", role: "user", parts: [{ type: "text", text }] },
];

const text = (chunks: UIMessageChunk[]) =>
  chunks.map((c) => (c.type === "text-delta" ? c.delta : "")).join("");
const toolOutputs = (chunks: UIMessageChunk[]) =>
  chunks.flatMap((c) => (c.type === "tool-output-available" ? [c.output] : []));

describe("Chat (D25)", () => {
  test("answers what the user waits on from a team using local data", async () => {
    const { layer, models } = intakeTestLayer({
      "std-m": [
        { toolCall: { name: "waiting_on", input: { owner: "Platform" } } },
        { text: "You are waiting on Platform for the ledger fix (INC0012345) on PAY-2." },
      ],
    });
    const chunks = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const platform = yield* createTeam({ name: "Platform" });
          yield* createDependency({
            issueKey: "PAY-2",
            kind: "incident",
            label: "Ledger fix",
            ownerTeamId: platform,
            externalRef: "INC0012345",
          });
          const stream = yield* (yield* Chat).stream({
            messages: ask("What am I waiting on from Platform?"),
          });
          return yield* Effect.promise(() => drainStream(stream));
        }),
        layer,
      ),
    );
    expect(toolOutputs(chunks)[0]).toMatchObject({
      waiting: [
        {
          issueKey: "PAY-2",
          label: "Ledger fix",
          owner: "Platform (team)",
          externalRef: "INC0012345",
        },
      ],
    });
    expect(text(chunks)).toContain("INC0012345");
    // The second step saw the tool result, and the system prompt keeps writes out of the chat.
    expect(promptOf(models.calls, 1)).toContain("Ledger fix");
    expect(promptOf(models.calls, 0)).toContain("call propose_actions");
  });

  test("a requested change becomes a pending proposal through intake, not a write", async () => {
    const e = { rationale: "asked in chat", evidence: "we are blocked", confidence: 0.9 };
    const { layer } = intakeTestLayer({
      "std-m": [
        {
          toolCall: {
            name: "propose_actions",
            input: { request: "Comment on PAY-4 that we are blocked" },
          },
        },
        out({
          summary: "Comment on PAY-4",
          question: null,
          confidence: 0.9,
          proposals: [{ kind: "add_comment", target: "PAY-4", body: "We are blocked.", ...e }],
        }),
        { text: "I proposed a comment on PAY-4; approve it in the Inbox." },
      ],
    });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const stream = yield* (yield* Chat).stream({
            messages: ask("comment on PAY-4 that we are blocked"),
          });
          const chunks = yield* Effect.promise(() => drainStream(stream));
          const output = toolOutputs(chunks)[0] as { threadId: string; proposed: string[] };
          const rows = yield* query((d) =>
            d.select().from(proposals).where(eq(proposals.inboxItemId, output.threadId)).all(),
          );
          return { output, rows, chunks };
        }),
        layer,
      ),
    );
    expect(r.output.proposed).toEqual(["Comment on PAY-4"]);
    expect(r.rows.map((p) => [p.kind, p.status])).toEqual([["add_comment", "pending"]]);
    expect(text(r.chunks)).toContain("approve it in the Inbox");
  });

  test("a failing tool tells the model why instead of ending the turn", async () => {
    const { layer } = intakeTestLayer({
      "std-m": [
        { toolCall: { name: "search_confluence", input: { text: "runbook" } } },
        { text: "Confluence is not set up." },
      ],
    });
    const chunks = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const stream = yield* (yield* Chat).stream({ messages: ask("find the runbook") });
          return yield* Effect.promise(() => drainStream(stream));
        }),
        layer,
      ),
    );
    expect(toolOutputs(chunks)[0]).toHaveProperty("error");
    expect(text(chunks)).toBe("Confluence is not set up.");
  });
});

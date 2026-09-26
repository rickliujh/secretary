import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";
import { Effect } from "effect";
import { chatConversations } from "@/db/schema";
import { query } from "@/services/db";
import { DbTest } from "@/services/db/test";
import {
  deleteConversation,
  listConversations,
  loadConversation,
  saveConversation,
  titleOf,
} from "./history";

const user = (id: string, text: string): UIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text }],
});
const answer = (id: string, text: string): UIMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "text", text }],
});

describe("chat history (D28)", () => {
  test("saves, reloads, updates and deletes a conversation", async () => {
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* saveConversation("c1", []);
          const empty = yield* listConversations;
          const first = [
            user("u1", "What am I\n waiting on from Platform?"),
            answer("a1", "INC0012345."),
          ];
          yield* saveConversation("c1", first);
          yield* saveConversation("c1", [...first, user("u2", "And from Tom?")]);
          const listed = yield* listConversations;
          const loaded = yield* loadConversation("c1");
          yield* deleteConversation("c1");
          return { empty, listed, loaded, after: yield* listConversations };
        }),
        DbTest,
      ),
    );
    expect(r.empty).toEqual([]);
    expect(r.listed).toMatchObject([{ id: "c1", title: "What am I waiting on from Platform?" }]);
    expect(r.loaded.map((m) => m.id)).toEqual(["u1", "a1", "u2"]);
    expect(r.after).toEqual([]);
  });

  test("an unreadable stored conversation opens empty instead of failing", async () => {
    const loaded = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* query((d) =>
            d.insert(chatConversations).values({
              id: "bad",
              title: "x",
              messages: [{ nonsense: true }],
              createdAt: "2026-09-26T00:00:00Z",
              updatedAt: "2026-09-26T00:00:00Z",
            }),
          );
          return yield* loadConversation("bad");
        }),
        DbTest,
      ),
    );
    expect(loaded).toEqual([]);
  });

  test("titles come from the first question and are shortened", () => {
    expect(titleOf([])).toBe("New chat");
    expect(titleOf([user("u", "x".repeat(200))])).toHaveLength(80);
  });
});

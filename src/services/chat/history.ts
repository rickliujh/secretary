/** Saved chat conversations (design.md D28). */
import type { UIMessage } from "ai";
import { desc, eq } from "drizzle-orm";
import { Effect } from "effect";
import { z } from "zod";
import { chatConversations } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { query } from "@/services/db";

const TITLE_LENGTH = 80;

/** Enough shape to render a stored message; parts are the AI SDK's own. */
const StoredMessages = z.array(
  z.looseObject({
    id: z.string(),
    role: z.enum(["user", "assistant", "system"]),
    parts: z.array(z.looseObject({ type: z.string() })),
  }),
);

/** The first question, on one line, as the conversation's title. */
export function titleOf(messages: readonly UIMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  const text = (first?.parts ?? [])
    .map((p) => (p.type === "text" ? p.text : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "New chat";
  return text.length > TITLE_LENGTH ? `${text.slice(0, TITLE_LENGTH - 1)}…` : text;
}

export type ConversationSummary = { id: string; title: string; updatedAt: string };

export const listConversations = query((d) =>
  d
    .select({
      id: chatConversations.id,
      title: chatConversations.title,
      updatedAt: chatConversations.updatedAt,
    })
    .from(chatConversations)
    .orderBy(desc(chatConversations.updatedAt))
    .limit(200)
    .all(),
);

/** Stored messages, or an empty list for a new or unreadable conversation. */
export const loadConversation = (id: string) =>
  Effect.map(
    query((d) => d.select().from(chatConversations).where(eq(chatConversations.id, id)).get()),
    (row) => {
      const parsed = StoredMessages.safeParse(row?.messages ?? []);
      return parsed.success ? (parsed.data as unknown as UIMessage[]) : [];
    },
  );

/** Saves the whole conversation; nothing is stored until it has a message. */
export const saveConversation = (id: string, messages: readonly UIMessage[]) =>
  Effect.gen(function* () {
    if (messages.length === 0) return;
    const now = nowIso();
    yield* query((d) =>
      d
        .insert(chatConversations)
        .values({
          id,
          title: titleOf(messages),
          messages: [...messages],
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: chatConversations.id,
          set: { messages: [...messages], updatedAt: now },
        }),
    );
  });

export const deleteConversation = (id: string) =>
  query((d) => d.delete(chatConversations).where(eq(chatConversations.id, id)));

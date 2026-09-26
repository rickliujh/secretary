/**
 * Chats live here, outside React, for as long as the app runs (design.md D28):
 * leaving the Chat page and coming back finds the same conversation, even while
 * an answer is still streaming. Every finished turn is saved.
 */
import { Chat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { queryClient, queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { logger } from "@/lib/log";
import { saveConversation } from "@/services/chat/history";
import type { Tier } from "@/services/llm";
import { SecretaryTransport } from "./transport";

let tier: Tier | undefined;
/** The tier picker's choice, read when a message is sent. */
export const setChatTier = (t: Tier | undefined) => {
  tier = t;
};
export const chatTier = () => tier;

let lastOpened: string | null = null;
/** The conversation to show when the Chat page opens without one. */
export const lastChat = () => lastOpened;

const transport = new SecretaryTransport(() => tier);
const chats = new Map<string, Chat<UIMessage>>();

const save = (id: string, messages: UIMessage[]) =>
  run(saveConversation(id, messages))
    .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.chats }))
    .catch((e) => logger.warn("Saving the chat failed", e));

export const hasChat = (id: string) => chats.has(id);

export function chatFor(id: string, stored: UIMessage[]): Chat<UIMessage> {
  lastOpened = id;
  const existing = chats.get(id);
  if (existing) return existing;
  const chat: Chat<UIMessage> = new Chat<UIMessage>({
    id,
    messages: stored,
    transport,
    // Also after an error or a stop, so the question is not lost.
    onFinish: ({ messages }) => void save(id, messages),
    onError: () => void save(id, chat.messages),
  });
  chats.set(id, chat);
  return chat;
}

export function forgetChat(id: string) {
  void chats.get(id)?.stop();
  chats.delete(id);
  if (lastOpened === id) lastOpened = null;
}

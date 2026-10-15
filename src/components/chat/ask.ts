/**
 * Opening the chat with a question (D42): the dashboard's suggested prompts
 * navigate to `/chat?c=<new id>&ask=<message>` and the thread sends it once.
 */
import { newId } from "@/lib/ids";

/** Search params that open a new conversation and ask `message` in it. */
export const askSearch = (message: string, id: string = newId()) => ({ c: id, ask: message });

const asked = new Set<string>();

/**
 * True the first time a conversation asks this question, false after. Guards
 * against React StrictMode running the effect twice and against re-renders
 * before the URL loses `ask`.
 */
export function claimAsk(conversation: string, message: string): boolean {
  const key = `${conversation}\n${message}`;
  if (asked.has(key)) return false;
  asked.add(key);
  return true;
}

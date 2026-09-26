/**
 * `route_reply`: which items of a thread a typed follow-up is about (design.md
 * D22). Only asked when the thread has several items and the reply is not an
 * answer to a specific question; the answer is an enum of item numbers.
 */
import { z } from "zod";
import { HARD_RULES, untrusted } from "./common";

export type RouteItem = { quote: string; proposals: string[] };

export function buildRouteReplySchema(count: number) {
  const numbers = Array.from({ length: count }, (_, i) => String(i + 1));
  return z.object({
    items: z
      .array(z.enum(numbers as [string, ...string[]]))
      .describe("Numbers of the items the follow-up is about"),
  });
}
export type RouteReplyOutput = { items: string[] };

export function buildRouteReplyPrompt(items: readonly RouteItem[], instruction: string) {
  return {
    system: `You help a personal work assistant apply a follow-up from the user to the right part of an earlier input. The input was split into numbered items, each with the actions proposed for it. Decide which items the follow-up is about.
${HARD_RULES}
- Pick every item the follow-up changes or adds to. If it applies to all of them, or you cannot tell, pick them all.`,
    prompt: [
      ...items.map(
        (item, i) =>
          `## Item ${i + 1}\n${untrusted(item.quote)}\nProposed: ${item.proposals.join("; ") || "nothing"}`,
      ),
      `## Follow-up from the user (trusted)\n${instruction}`,
    ].join("\n\n"),
  };
}

export function validateRouteReply(out: RouteReplyOutput): string[] {
  return out.items.length === 0 ? ["Pick at least one item."] : [];
}

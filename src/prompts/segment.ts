/** `segment_input`: split a long paste into atomic items (design.md 7.3 step 2). */
import { z } from "zod";
import { HARD_RULES, untrusted } from "./common";

export const SEGMENT_PROMPT_VERSION = 1;
export const MAX_SEGMENTS = 10;

export const SegmentOutputSchema = z.object({
  items: z.array(
    z.object({
      quote: z.string().describe("The exact text of this item, copied verbatim from the input"),
      topic: z.string().describe("A few words naming what the item is about"),
    }),
  ),
});
export type SegmentOutput = z.infer<typeof SegmentOutputSchema>;

export function buildSegmentPrompt(text: string, source: string) {
  return {
    system: `You split messages into separate actionable items for a personal work assistant.
${HARD_RULES}

An item is one request, update or piece of information that could lead to its own action (a ticket update, a comment, a dependency to track, a fact about a person or team). Keep related sentences together. Drop greetings, sign-offs and chatter. Copy each item's text exactly; do not rewrite it. Return at most ${MAX_SEGMENTS} items.`,
    prompt: untrusted(text, { source }),
  };
}

const squash = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Every quote must be a verbatim span of the input (ignoring whitespace differences). */
export function validateSegments(out: SegmentOutput, text: string): string[] {
  const haystack = squash(text);
  const errors: string[] = [];
  if (out.items.length === 0) errors.push("Return at least one item.");
  if (out.items.length > MAX_SEGMENTS) errors.push(`Return at most ${MAX_SEGMENTS} items.`);
  out.items.forEach((item, i) => {
    if (!item.quote.trim()) errors.push(`Item ${i + 1} has an empty quote.`);
    else if (!haystack.includes(squash(item.quote)))
      errors.push(
        `Item ${i + 1} quote is not copied verbatim from the input: "${item.quote.slice(0, 80)}"`,
      );
  });
  return errors;
}

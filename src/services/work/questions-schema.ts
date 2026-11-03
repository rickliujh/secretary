/**
 * The work model's questions (FR-19.4, D61): `needs_clarification` proposals
 * that carry `work`, so their answer goes to the work model, not to classify.
 * Kept free of other imports: the proposal schema reads it.
 */
import { z } from "zod";

export const WorkQuestionSchema = z.discriminatedUnion("type", [
  /** Which item an event belongs to: one choice per item, plus none of them. */
  z.object({
    type: z.literal("attach"),
    eventId: z.string(),
    itemIds: z.array(z.string()).min(1),
  }),
  /** Whether two items are one piece of work (a group that would pass the cap, a link between items). */
  z.object({
    type: z.literal("group"),
    key: z.string(),
    itemIds: z.array(z.string()).length(2),
  }),
  /** What the state update could not settle (what a commitment means); the answer is an event. */
  z.object({ type: z.literal("meaning"), itemId: z.string() }),
]);
export type WorkQuestion = z.infer<typeof WorkQuestionSchema>;

/** The choice meaning "none of these items". */
export const NONE_OF_THESE = "None of these";
export const ONE_PIECE = "Yes, one piece of work";
export const KEEP_APART = "No, keep them apart";

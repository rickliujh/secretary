import { z } from "zod";
import { SUBJECT_TYPES } from "@/services/directory/schema";
import { MEMORY_KINDS } from "@/services/proposals/schema";

/** The kinds the user writes on the Memory page; examples come from corrections. */
export const EDITABLE_KINDS = MEMORY_KINDS;

/** Weight presets shown in the UI; ranking multiplies by the stored number. */
export const WEIGHTS = { low: 0.5, normal: 1, high: 2 } as const;

export const MemoryInputSchema = z
  .object({
    kind: z.enum(EDITABLE_KINDS),
    content: z.string().trim().min(1, "Write the rule, fact or preference").max(2000),
    subjectType: z.enum(SUBJECT_TYPES).nullable().default(null),
    subjectId: z.string().trim().nullable().default(null),
    weight: z.number().min(0.1).max(5).default(1),
  })
  .refine((m) => !m.subjectType === !m.subjectId, {
    path: ["subjectId"],
    message: "Pick what this is about, or clear it",
  });
export type MemoryInput = z.input<typeof MemoryInputSchema>;

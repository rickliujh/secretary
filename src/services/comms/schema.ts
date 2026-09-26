import { z } from "zod";
import { IssueKey, MESSAGE_INTENTS } from "@/services/proposals/schema";

export const DRAFT_CHANNELS = ["teams", "email"] as const;
export const DRAFT_VARIANTS = ["short", "standard"] as const;

/** A new draft from the composer (FR-6.1). */
export const DraftRequestSchema = z
  .object({
    kind: z.enum(DRAFT_CHANNELS),
    intent: z.enum(MESSAGE_INTENTS),
    recipientPersonId: z.string().nullable().default(null),
    recipientTeamId: z.string().nullable().default(null),
    issueKeys: z.array(IssueKey).default([]),
    dependencyId: z.string().nullable().default(null),
    notes: z.string().trim().max(4000).default(""),
  })
  .refine((r) => !!r.recipientPersonId || !!r.recipientTeamId, {
    path: ["recipientPersonId"],
    message: "Pick a person or a team",
  });
export type DraftRequest = z.input<typeof DraftRequestSchema>;

/** The user's edit of the text they will send. */
export const DraftEditSchema = z.object({
  variant: z.enum(DRAFT_VARIANTS),
  subject: z.string().max(300).nullable(),
  bodyMd: z.string(),
});
export type DraftEdit = z.input<typeof DraftEditSchema>;

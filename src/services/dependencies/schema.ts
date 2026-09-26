import { z } from "zod";
import { DEPENDENCY_KINDS, IsoDate, IssueKey } from "@/services/proposals/schema";

export const DEPENDENCY_STATUSES = ["open", "waiting", "blocked", "resolved"] as const;
export const FOLLOWUP_CHANNELS = ["teams", "email", "meeting", "phone", "jira", "other"] as const;

export const DependencyInputSchema = z
  .object({
    issueKey: IssueKey,
    kind: z.enum(DEPENDENCY_KINDS),
    label: z.string().trim().min(1, "Describe what the issue waits on").max(300),
    ownerPersonId: z.string().nullable().default(null),
    ownerTeamId: z.string().nullable().default(null),
    externalRef: z.string().trim().max(100).nullable().default(null),
    externalUrl: z.union([z.url({ protocol: /^https?$/ }), z.null()]).default(null),
    status: z.enum(DEPENDENCY_STATUSES).default("open"),
    expectedAt: IsoDate.nullable().default(null),
    nextFollowupAt: IsoDate.nullable().default(null),
    notesMd: z.string().nullable().default(null),
  })
  .refine((d) => d.kind !== "incident" || !!d.externalRef, {
    path: ["externalRef"],
    message: "An incident needs its number, e.g. INC0012345",
  });
export type DependencyInput = z.input<typeof DependencyInputSchema>;

export const FollowupInputSchema = z.object({
  channel: z.enum(FOLLOWUP_CHANNELS),
  summary: z.string().trim().max(2000).nullable().default(null),
  /** Defaults to the configured number of working days from today. */
  nextFollowupAt: IsoDate.nullable().optional(),
  communicationId: z.string().nullable().default(null),
});
export type FollowupInput = z.input<typeof FollowupInputSchema>;

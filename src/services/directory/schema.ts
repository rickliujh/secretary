/** zod schemas for teams, people and context notes (FR-4.1, FR-4.2). */
import { z } from "zod";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .default(null);

export const FORMALITY = ["formal", "neutral", "casual"] as const;
export const DETAIL = ["brief", "balanced", "detailed"] as const;
export const RESPONSIVENESS = ["fast", "normal", "slow"] as const;
export const CHANNELS = ["teams", "email", "meeting", "phone", "other"] as const;

/** Communication profile; every field optional so partial knowledge is fine. */
export const ProfileSchema = z.object({
  tone: z.string().trim().max(200).optional(),
  formality: z.enum(FORMALITY).optional(),
  detail: z.enum(DETAIL).optional(),
  responsiveness: z.enum(RESPONSIVENESS).optional(),
  preferredChannel: z.enum(CHANNELS).optional(),
  language: z.string().trim().max(50).optional(),
});
export type Profile = z.infer<typeof ProfileSchema>;

/** Drops empty strings so the stored JSON only holds what is known. */
export function compactProfile(p: Profile): Profile {
  return Object.fromEntries(
    Object.entries(p).filter(([, v]) => v !== undefined && v !== ""),
  ) as Profile;
}

export const TeamInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  function: optionalText(500),
  contactFor: optionalText(1000),
  channel: optionalText(200),
  escalationPath: optionalText(1000),
  confluenceUrls: z.array(z.url({ protocol: /^https?$/ })).default([]),
  notesMd: optionalText(20000),
});
export type TeamInput = z.input<typeof TeamInputSchema>;

export const PersonInputSchema = z.object({
  displayName: z.string().trim().min(1, "Name is required").max(200),
  jiraUsername: optionalText(200),
  email: z
    .union([z.literal(""), z.email()])
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .default(null),
  title: optionalText(200),
  teamId: z.string().nullable().default(null),
  responsibilities: optionalText(2000),
  profile: ProfileSchema.default({}),
  notesMd: optionalText(20000),
});
export type PersonInput = z.input<typeof PersonInputSchema>;

export const SUBJECT_TYPES = ["team", "person", "issue"] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];
export type Subject = { type: SubjectType; id: string };

export const NoteInputSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(300),
  bodyMd: z.string().max(200_000),
});
export type NoteInput = z.input<typeof NoteInputSchema>;

/** Jira user ids compare case-insensitively (DC usernames are; Cloud account IDs are lower-case). */
export const normalizeUsername = (u: string | null | undefined) => (u ?? "").trim().toLowerCase();

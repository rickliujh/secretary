import { Context, Data, type Effect } from "effect";
import { z } from "zod";

export type JiraErrorKind = "not_configured" | "auth" | "http" | "network" | "timeout" | "decode";

export class JiraError extends Data.TaggedError("JiraError")<{
  readonly kind: JiraErrorKind;
  readonly message: string;
  readonly status?: number;
}> {}

/** `GET /rest/api/2/myself` on Data Center. */
export const JiraUserSchema = z.object({
  name: z.string(),
  key: z.string().optional(),
  displayName: z.string(),
  emailAddress: z.string().optional(),
  active: z.boolean().optional(),
  timeZone: z.string().optional(),
});
export type JiraUser = z.infer<typeof JiraUserSchema>;

export type Credentials = { baseUrl?: string; pat?: string };

export interface JiraClientShape {
  /**
   * Calls `/myself`. Values passed in override stored ones so the settings form
   * can test before saving.
   */
  readonly testConnection: (overrides?: Credentials) => Effect.Effect<JiraUser, JiraError>;
}

export class JiraClient extends Context.Tag("JiraClient")<JiraClient, JiraClientShape>() {}

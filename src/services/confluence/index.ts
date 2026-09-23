import { Context, Data, type Effect } from "effect";
import { z } from "zod";

export type ConfluenceErrorKind =
  | "not_configured"
  | "auth"
  | "http"
  | "network"
  | "timeout"
  | "decode";

export class ConfluenceError extends Data.TaggedError("ConfluenceError")<{
  readonly kind: ConfluenceErrorKind;
  readonly message: string;
  readonly status?: number;
}> {}

/** `GET /rest/api/user/current` on Data Center. */
export const ConfluenceUserSchema = z.object({
  type: z.string(),
  username: z.string().optional(),
  userKey: z.string().optional(),
  displayName: z.string(),
});
export type ConfluenceUser = z.infer<typeof ConfluenceUserSchema>;

export type Credentials = { baseUrl?: string; pat?: string };

export interface ConfluenceClientShape {
  readonly testConnection: (
    overrides?: Credentials,
  ) => Effect.Effect<ConfluenceUser, ConfluenceError>;
}

export class ConfluenceClient extends Context.Tag("ConfluenceClient")<
  ConfluenceClient,
  ConfluenceClientShape
>() {}

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

const LinksSchema = z
  .object({ webui: z.string().optional(), base: z.string().optional() })
  .default({});

const SpaceSchema = z.object({ key: z.string(), name: z.string().optional() });
const VersionSchema = z.object({ number: z.number(), when: z.string().optional() });

export const ContentSummarySchema = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  space: SpaceSchema.optional(),
  version: VersionSchema.optional(),
  _links: LinksSchema,
});
export type ContentSummary = z.infer<typeof ContentSummarySchema>;

export const SearchResultSchema = z.object({
  results: z.array(ContentSummarySchema),
  start: z.number().default(0),
  limit: z.number().optional(),
  size: z.number(),
  totalSize: z.number().optional(),
  _links: LinksSchema,
});
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const PageSchema = ContentSummarySchema.extend({
  ancestors: z.array(z.object({ id: z.string(), title: z.string() })).default([]),
  body: z.object({ storage: z.object({ value: z.string() }) }),
  version: VersionSchema,
});
export type Page = z.infer<typeof PageSchema>;

/** Cloud v2 `GET /api/v2/pages/{id}?body-format=storage` (v1 get-content-by-id is deprecated there). */
export const V2PageSchema = z.object({
  id: z.string(),
  title: z.string(),
  spaceId: z.string(),
  version: z.object({ number: z.number(), createdAt: z.string().optional() }),
  body: z.object({ storage: z.object({ value: z.string() }) }),
  _links: z.object({ webui: z.string().optional(), base: z.string().optional() }).default({}),
});

/** Cloud v2 `GET /api/v2/spaces/{id}`. */
export const V2SpaceSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string().optional(),
});

export type { Credentials } from "@/services/atlassian/credentials";

import type { Credentials } from "@/services/atlassian/credentials";

export interface ConfluenceClientShape {
  readonly testConnection: (
    overrides?: Credentials,
  ) => Effect.Effect<ConfluenceUser, ConfluenceError>;
  readonly baseUrl: Effect.Effect<string, ConfluenceError>;
  readonly search: (
    cql: string,
    opts?: { limit?: number; start?: number },
  ) => Effect.Effect<SearchResult, ConfluenceError>;
  readonly getPage: (id: string) => Effect.Effect<Page, ConfluenceError>;
}

export class ConfluenceClient extends Context.Tag("ConfluenceClient")<
  ConfluenceClient,
  ConfluenceClientShape
>() {}

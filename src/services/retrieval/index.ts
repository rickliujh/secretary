import { Context, type Effect } from "effect";
import type { ItemSnapshot, ThreadContext } from "@/prompts/classify";
import type { DbError } from "@/services/db";
import type { References } from "@/services/intake/preprocess";

export type SnapshotRequest = {
  quote: string;
  source: string;
  senderPersonId: string | null;
  references: References;
  today: string;
  /** The day the item's input arrived, when it is older than today (a revision, D44). */
  askedOn?: string;
  /** Thread context for a follow-up (design.md D22). */
  thread?: ThreadContext | null;
  /** Keys never offered, whatever finds them: tickets a revoke deleted (FR-14.6). */
  exclude?: readonly string[];
  /** Tickets this thread created and then revoked (FR-14.6), for how a closed one reads. */
  revokedHere?: readonly string[];
  /**
   * The keys the item itself names, without the thread's (D61 Reads): the work
   * block tells "names a ticket" from "the thread is about it". Absent: all of
   * `references.issueKeys`.
   */
  ownKeys?: readonly string[];
  /** The input is the user's own words: a work block may show the item they are on. */
  ownInput?: boolean;
  /** The Inbox thread the item is in; its own messages stay out of the work block's events. */
  inboxItemId?: string;
};

export interface RetrievalShape {
  /** Deterministic context for one item: candidates, directory, memories, notes (design.md 7.3 step 3). */
  readonly snapshot: (req: SnapshotRequest) => Effect.Effect<ItemSnapshot, DbError>;
}

export class Retrieval extends Context.Tag("Retrieval")<Retrieval, RetrievalShape>() {}

/** Token budgets per prompt block (design.md 7.2). */
export const BUDGETS = {
  candidates: 3500,
  people: 1200,
  teams: 800,
  memories: 1200,
  examples: 1500,
  notes: 1500,
  jiraUsers: 400,
  /** The work block (D61 Reads, prompt version 15). */
  work: 1200,
} as const;

export const CANDIDATE_LIMIT = 25;

/**
 * At most this many of the work block's primary tickets pass the candidate
 * limit and budget like named ones (D61 Reads); the rest rank after search.
 */
export const WORK_CANDIDATE_LIMIT = 10;

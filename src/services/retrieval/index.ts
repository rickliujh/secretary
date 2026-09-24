import { Context, type Effect } from "effect";
import type { ItemSnapshot } from "@/prompts/classify";
import type { DbError } from "@/services/db";
import type { References } from "@/services/intake/preprocess";

export type SnapshotRequest = {
  quote: string;
  source: string;
  senderPersonId: string | null;
  references: References;
  today: string;
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
} as const;

export const CANDIDATE_LIMIT = 25;

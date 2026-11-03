/**
 * Classify's own proposals of a thread, for scoring the model (Phase 26): a
 * playbook's chores (rows of a bundle that are not the proposal it expanded)
 * are code's, not the model's, and an expanded proposal is scored as the
 * model made it, before the playbook set its follow-up, mirror and reference.
 */
import { asc, eq } from "drizzle-orm";
import { Effect } from "effect";
import { bundles, proposals } from "@/db/schema";
import { query } from "@/services/db";
import { type ProposalPayload, ProposalPayloadSchema } from "@/services/proposals/schema";
import { bundleRecordOf } from "@/services/work/schema";

type Row = { id: string; bundleId: string | null; payload: unknown; status: string };

/** A chore a playbook added: in a bundle, and not the proposal the bundle expanded. */
export const isChore = (r: { id: string; bundleId: string | null }) =>
  !!r.bundleId && r.bundleId !== r.id;

/** The model's payloads among the rows; `origins` maps a bundle id to the proposal it expanded. */
export function ownPayloads(
  rows: readonly Row[],
  origins: ReadonlyMap<string, unknown>,
): ProposalPayload[] {
  return rows
    .filter((r) => r.status !== "superseded" && !isChore(r))
    .map((r) => {
      const origin = r.bundleId ? ProposalPayloadSchema.safeParse(origins.get(r.bundleId)) : null;
      return origin?.success ? origin.data : (r.payload as ProposalPayload);
    });
}

/** The model's proposals of one thread, in order, as `ownPayloads` reads them. */
export const classifyOwn = (inboxItemId: string) =>
  Effect.gen(function* () {
    const rows = yield* query((d) =>
      d
        .select()
        .from(proposals)
        .where(eq(proposals.inboxItemId, inboxItemId))
        .orderBy(asc(proposals.seq))
        .all(),
    );
    const stored = yield* query((d) =>
      d.select().from(bundles).where(eq(bundles.inboxItemId, inboxItemId)).all(),
    );
    return ownPayloads(
      rows,
      new Map(stored.map((b) => [b.id, bundleRecordOf(b.record)?.origin ?? null])),
    );
  });

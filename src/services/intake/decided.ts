/**
 * What later turns of a thread are told about its proposals that are no longer
 * open (D22), and what a revoke left of the tickets the thread created (FR-14.6,
 * D54): a revoked proposal reads as approved and then revoked, with what the
 * revoke did; a pending proposal dropped because its ticket was revoked reads as
 * dropped, not as rejected by the user.
 */
import type { DecidedProposal } from "@/prompts/classify";
import type { RevokedRecord } from "@/services/proposals";
import { revokedTicket } from "@/services/proposals/revoke";
import { describePayload, effectivePayload, resolveRefs } from "@/services/proposals/schema";

type Row = {
  kind: string;
  status: string;
  payload: unknown;
  editedPayload: unknown;
  result: unknown;
};

type Result = {
  issueKey?: string;
  revoked?: RevokedRecord;
  dismissed?: boolean;
  reason?: string;
} | null;

const CLOSED_STATUSES = ["executed", "approved", "failed", "rejected", "revoked"];

export type ThreadOutcomes = {
  decided: DecidedProposal[];
  /** Tickets the thread created that still exist: executed, or revoked and closed. */
  createdKeys: string[];
  /** Tickets the thread created that a revoke deleted; never candidates again. */
  deletedKeys: string[];
};

/** What an older record without `unchanged` says when nothing was changed back. */
const NOTHING_LEFT = "Nothing was left to undo.";

/**
 * `statusOf` gives a ticket's cached status, for a revoked create whose ticket
 * was already closed, so the revoke moved nothing.
 */
export function threadOutcomes(
  rows: readonly Row[],
  statusOf: (key: string) => string | null = () => null,
): ThreadOutcomes {
  // Created tickets by the `$new` ref their proposals were made with.
  const created = new Map<string, string>();
  const createdKeys: string[] = [];
  const deletedKeys: string[] = [];
  const tickets = new Map<Row, string>();
  for (const r of rows) {
    if (r.kind !== "create_issue") continue;
    const p = effectivePayload(r);
    const res = r.result as Result;
    const key = res?.issueKey;
    if (!key || (r.status !== "executed" && r.status !== "revoked")) continue;
    if (p.kind === "create_issue") created.set(p.ref, key);
    if (r.status === "executed") {
      createdKeys.push(key);
      continue;
    }
    if (!res?.revoked) continue;
    const t = revokedTicket(key, res.revoked);
    if (t.state === "deleted") {
      deletedKeys.push(key);
      tickets.set(r, `${key} was deleted and no longer exists`);
      continue;
    }
    createdKeys.push(key);
    if (t.moved && t.status) {
      tickets.set(r, `${key} was closed and moved to ${t.status}`);
      continue;
    }
    // Already closed before the revoke: as it is now, else as the revoke saw it.
    const now = statusOf(key) ?? t.status;
    tickets.set(r, `${key} is closed${now ? ` (${now})` : ""}`);
  }
  const decided = rows
    .filter((r) => r.kind !== "needs_clarification" && CLOSED_STATUSES.includes(r.status))
    .map((r): DecidedProposal => {
      const description = describePayload(resolveRefs(effectivePayload(r), created));
      const res = r.result as Result;
      const record = res?.revoked;
      if (r.status === "revoked") {
        const ticket = tickets.get(r);
        if (ticket) return { outcome: "revoked", description, undone: ticket };
        return {
          outcome: "revoked",
          description,
          undone: record?.message ?? "",
          ...((record?.unchanged ?? record?.message === NOTHING_LEFT) ? { unchanged: true } : {}),
          ...(record?.warning ? { kept: record.warning } : {}),
        };
      }
      if (r.status === "rejected" && res?.dismissed && res.reason)
        return { outcome: "dropped", description, reason: res.reason };
      return { outcome: r.status === "rejected" ? "rejected" : "done", description };
    });
  return { decided, createdKeys, deletedKeys };
}

/**
 * Open dependencies as intake candidates (D46): the waits pasted text may
 * answer. Pure ranking, so update_dependency only ever picks from these.
 */
import { localDateOf } from "@/lib/dates";
import type { WaitCandidate, WaitReason } from "@/prompts/classify";
import { isAway } from "@/services/directory/away";
import { overlap, tokens } from "./ranking";

/** At most this many open waits reach the prompt. */
export const WAIT_LIMIT = 12;

export type WaitRow = {
  id: string;
  issueKey: string;
  label: string;
  kind: string;
  externalRef: string | null;
  status: string;
  ownerPersonId: string | null;
  ownerTeamId: string | null;
  /** The owner's name, or null without one. */
  owner: string | null;
  /** The team of a person owner. */
  ownerPersonTeamId: string | null;
  /** The person owner's away date (D47). */
  ownerAwayUntil: string | null;
  requestedAt: string | null;
  expectedAt: string | null;
  nextFollowupAt: string | null;
  issueSummary: string | null;
};

export type WaitContext = {
  senderPersonId: string | null;
  senderTeamId: string | null;
  /** Contacts the input names. */
  namedPersonIds: readonly string[];
  /** Candidate issue keys, and those the input names explicitly. */
  candidateKeys: readonly string[];
  mentionedKeys: readonly string[];
  quote: string;
  today: string;
};

/**
 * Whether `text` names a reference (an incident number, a request id) as a whole:
 * INC0012 is not in INC00123. Case is ignored.
 */
export function mentionsRef(text: string, ref: string): boolean {
  const r = ref.trim();
  if (!r) return false;
  const escaped = r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(text);
}

type WaitSubject = { label: string | null; externalRef: string | null };

/**
 * Whether two waits are about the same thing (D46), by the wording match used
 * to offer waits: the same external reference (when both have one, it decides),
 * one's reference named in the other's label, or labels sharing a meaningful
 * word other than the owner's name.
 */
export function sameWaitSubject(a: WaitSubject, b: WaitSubject, owner?: string | null): boolean {
  const ra = a.externalRef?.trim() || null;
  const rb = b.externalRef?.trim() || null;
  if (ra && rb) return ra.toLowerCase() === rb.toLowerCase();
  if (ra && b.label && mentionsRef(b.label, ra)) return true;
  if (rb && a.label && mentionsRef(a.label, rb)) return true;
  const ignore = new Set(tokens(owner ?? ""));
  const words = (label: string | null) => tokens(label ?? "").filter((t) => !ignore.has(t));
  return overlap(words(a.label).join(" "), words(b.label).join(" ")) > 0;
}

const POINTS: Record<WaitReason, number> = {
  sender: 8,
  named: 6,
  team: 4,
  ticket: 3,
  wording: 0,
};

/**
 * The open waits an input may be about, most likely first: owned by the sender,
 * by a contact the input names or by the sender's team, on a candidate ticket,
 * or sharing words (or an incident number) with the input. Waits with none of
 * these are left out; at most `limit` are kept.
 */
export function pickWaits(
  rows: readonly WaitRow[],
  ctx: WaitContext,
  limit = WAIT_LIMIT,
): WaitCandidate[] {
  const candidates = new Set(ctx.candidateKeys);
  const mentioned = new Set(ctx.mentionedKeys);
  const named = new Set(ctx.namedPersonIds);
  return rows
    .filter((r) => r.status !== "resolved")
    .map((r) => {
      const reasons: WaitReason[] = [];
      let score = 0;
      const add = (reason: WaitReason, extra = 0) => {
        if (!reasons.includes(reason)) reasons.push(reason);
        score += POINTS[reason] + extra;
      };
      if (ctx.senderPersonId && r.ownerPersonId === ctx.senderPersonId) add("sender");
      if (r.ownerPersonId && named.has(r.ownerPersonId)) add("named");
      if (
        ctx.senderTeamId &&
        (r.ownerTeamId === ctx.senderTeamId ||
          (r.ownerPersonId !== ctx.senderPersonId && r.ownerPersonTeamId === ctx.senderTeamId))
      )
        add("team", r.ownerTeamId === ctx.senderTeamId ? 0 : -2);
      if (candidates.has(r.issueKey)) add("ticket", mentioned.has(r.issueKey) ? 2 : 0);
      const words = overlap(
        [r.label, r.externalRef, r.issueSummary, r.owner].filter(Boolean).join(" "),
        ctx.quote,
      );
      if (r.externalRef && mentionsRef(ctx.quote, r.externalRef)) add("wording", 6);
      else if (words > 0) add("wording", words * 10);
      return { r, reasons, score };
    })
    .filter((x) => x.reasons.length > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        (a.r.expectedAt ?? "9999").localeCompare(b.r.expectedAt ?? "9999") ||
        a.r.id.localeCompare(b.r.id),
    )
    .slice(0, limit)
    .map(({ r, reasons }) => ({
      id: r.id,
      issueKey: r.issueKey,
      label: r.label,
      kind: r.kind,
      owner: r.owner,
      ownerPersonId: r.ownerPersonId,
      ownerTeamId: r.ownerTeamId,
      externalRef: r.externalRef,
      status: r.status,
      requestedOn: r.requestedAt ? localDateOf(r.requestedAt) : null,
      expectedAt: r.expectedAt,
      nextFollowupAt: r.nextFollowupAt,
      awayUntil: isAway(r.ownerAwayUntil, ctx.today) ? r.ownerAwayUntil : null,
      reasons,
    }));
}

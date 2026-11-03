/**
 * What a block's card holds (FR-20.7, D67), as pure mappings: its head (title,
 * the state pill, which body, which buttons) from the block's mark and its
 * thread's summary, and its rows from the thread's proposals. The card
 * renders these with the Inbox's own decision, reply, revoke and edit code.
 */
import { type MarkState, markLabel, type ThreadSummary, threadMark } from "@/services/note/cards";
import {
  describePayload,
  effectivePayload,
  type ProposalPayload,
  proposalLabel,
} from "@/services/proposals/schema";
import { type BundleProposal, executedRefs, groupSmallAsks } from "@/services/small-asks/bundle";
import type { BlockMark } from "./block-marks";

export type CardTone = "waiting" | "ok" | "warn" | "bad" | "note" | "muted";

export type CardHead = {
  title: string;
  pill: string;
  tone: CardTone;
  /** What sits under the head. */
  body: "thread" | "noted" | "alone" | "unread" | "not_read" | "private";
  /** The block's words changed since it was read: "changed, not read yet". */
  changed: boolean;
  /** A reply box that continues the thread. */
  reply: boolean;
  /** Ask the secretary about the block (it has no conversation and is not private). */
  ask: boolean;
  /** "Read this now". */
  readNow: boolean;
  /** "Open in Inbox". */
  inbox: boolean;
};

type Opts = {
  /** Today's note: Read this now is offered. */
  editable: boolean;
  /** A reading will come (today, with reading on). */
  reads: boolean;
};

const none = {
  changed: false,
  reply: false,
  ask: false,
  readNow: false,
  inbox: false,
};

function threadHead(state: MarkState): Omit<CardHead, keyof typeof none | "body"> {
  switch (state.kind) {
    case "waiting":
      return { title: "From this line", pill: markLabel(state), tone: "waiting" };
    case "question":
      return { title: "One question before I act", pill: "needs you", tone: "warn" };
    case "failed":
      return {
        title: "Did not go through",
        pill: state.turn ? "error" : markLabel(state),
        tone: "bad",
      };
    case "done":
      return {
        title: "From this line",
        pill: state.ended,
        tone: state.ended === "approved" ? "ok" : "muted",
      };
    default:
      return { title: "From this line", pill: "reading...", tone: "muted" };
  }
}

/** The card's head for a block: by its mark's state, as D67 lists them. */
export function cardHead(
  mark: Pick<BlockMark, "state" | "changed" | "private" | "thread" | "row">,
  thread: ThreadSummary | undefined,
  opts: Opts,
): CardHead {
  const s = mark.state;
  if (s.kind === "private")
    return {
      ...none,
      title: "Private",
      pill: "never sent",
      tone: "muted",
      body: "private",
      inbox: !!mark.thread,
    };
  // A block with a conversation: the thread's content, also while its new words wait.
  if (mark.thread) {
    const state = thread ? threadMark(thread) : s;
    return {
      ...none,
      ...threadHead(state),
      body: "thread",
      changed: mark.changed,
      readNow: mark.changed && opts.reads && opts.editable,
      reply: true,
      inbox: true,
    };
  }
  switch (s.kind) {
    case "noted":
      return {
        ...none,
        title: `Noted on ${mark.row?.workItemName ?? "a work item"}`,
        pill: "context",
        tone: "note",
        body: "noted",
        ask: true,
      };
    case "unread":
      return {
        ...none,
        title: "Not read yet",
        pill: "in about a minute",
        tone: "muted",
        body: "unread",
        readNow: opts.editable,
      };
    case "not_read":
      return {
        ...none,
        title: "Not read",
        pill: "not read",
        tone: "muted",
        body: "not_read",
        ask: true,
      };
    default:
      return {
        ...none,
        title: "Nothing for the secretary",
        pill: "left alone",
        tone: "muted",
        body: "alone",
        ask: true,
      };
  }
}

/** A row of the card: the thread's proposals as the card shows them. */
export type CardEntry<P> =
  /** Pending (Approve, Edit, Reject) or failed (Retry). */
  | { type: "action"; proposal: P }
  /** A pending question: its choices. */
  | { type: "question"; proposal: P }
  /** Executed: what was done, Undo. */
  | { type: "done"; proposal: P }
  /** A small ask's Track row (D44). */
  | { type: "track"; create: P; members: P[] }
  /** A playbook bundle (Phase 26). */
  | { type: "bundle"; bundleId: string; proposals: P[] };

/**
 * The card's rows from a thread's proposals, in order: playbook bundles
 * first, then small-ask Track rows and single proposals as the thread
 * groups them. Replaced, rejected and revoked proposals and answered
 * questions are left out (the Inbox keeps the whole story).
 */
export function cardEntries<P extends BundleProposal & { bundleId: string | null }>(
  proposals: readonly P[],
): CardEntry<P>[] {
  const live = proposals.filter((p) => p.status !== "superseded");
  const bundles = new Map<string, P[]>();
  for (const p of live)
    if (p.bundleId) bundles.set(p.bundleId, [...(bundles.get(p.bundleId) ?? []), p]);
  const out: CardEntry<P>[] = [...bundles].map(([bundleId, list]) => ({
    type: "bundle",
    bundleId,
    proposals: list,
  }));
  const rest = live.filter((p) => !p.bundleId);
  for (const e of groupSmallAsks(rest, executedRefs(live))) {
    if (e.type === "track") {
      out.push(e);
      continue;
    }
    const p = e.proposal;
    if (p.kind === "needs_clarification") {
      if (p.status === "pending") out.push({ type: "question", proposal: p });
    } else if (p.status === "pending" || p.status === "failed")
      out.push({ type: "action", proposal: p });
    else if (p.status === "executed") out.push({ type: "done", proposal: p });
  }
  return out;
}

const clip = (s: string, n = 160) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** An action row's two lines: the kind and its target, and what it says. */
export function actionLines(p: ProposalPayload): { kind: string; what: string } {
  switch (p.kind) {
    case "create_issue":
      return {
        kind: `${proposalLabel(p)} · ${p.projectKey}${p.epic ? ` · under ${p.epic.startsWith("$new") ? "the new epic" : p.epic}` : ""}`,
        what: p.summary,
      };
    case "add_comment":
      return { kind: `Comment on ${p.target}`, what: clip(p.bodyMd.replace(/\s+/g, " ").trim()) };
    case "needs_clarification":
      return { kind: "Question", what: p.question };
    default:
      return { kind: proposalLabel(p), what: describePayload(p) };
  }
}

/** The payload a row shows: the edited one when there is one. */
export const shownPayload = (p: { payload: unknown; editedPayload: unknown }) =>
  effectivePayload(p);

/**
 * The error of a turn that did not go through, for "Try again": the thread's
 * error while its last message is the user's, as the Inbox's thread shows it,
 * whatever else the thread holds (approved or waiting cards).
 */
export function failedTurn(
  item: { error: string | null },
  messages: readonly { role: string }[],
): string | null {
  return item.error && messages.at(-1)?.role === "user" ? item.error : null;
}

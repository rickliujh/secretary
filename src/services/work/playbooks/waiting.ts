/**
 * The "waiting on someone" playbook (FR-19.7, D61, Phase 26), pure: a wait
 * becomes the complete set of chores a secretary would do, each its own step
 * (a canonical proposal payload) in one bundle:
 *
 * 1. the wait itself (`link_dependency`, the step the others hang on), with
 *    the next follow-up from the expected date or the owner's responsiveness,
 *    mirrored into Jira when `mirrorWaits` is on and there is a page, an email
 *    or a ticket to link (D18: Jira needs a URL);
 * 2. their ticket as the blocker (`link_issues`) when the search found one
 *    and `linkFoundTickets` is on; it runs only when a ticket is picked;
 * 3. a comment on the user's ticket saying who, what, when and where
 *    (`commentWaits`); the Executor sends it through `proposalTextToWiki`;
 * 4. a move to the project's first Blocked-like status (`blockedStatus`, off by
 *    default), when the project has one and the ticket is not in it already;
 * 5. the request message to the owner (`draftRequests`) when nothing was sent
 *    to them about the item yet and the input was not their own message.
 *
 * A wait with no owner (an incident, a vendor reference) gets the reduced
 * playbook: no search and no request, only the wait, the comment, the mirror
 * and the Blocked move.
 *
 * No model call: every text is a template filled from the facts.
 */
import { z } from "zod";
import { addBusinessDays } from "@/lib/dates";
import { nextFollowupAfter } from "@/services/dependencies/logic";
import type {
  PayloadOf,
  ProposalPayload,
  StoredProposalPayload,
} from "@/services/proposals/schema";
import type { Instructions } from "@/services/settings/schema";
import { BLOCKED_STATUS, dayLabel } from "../rules";
import type { Found, StepDraft } from "../schema";

/** The wait the playbook is about: a proposed `link_dependency`, or an existing wait. */
export type WaitingWait = Omit<PayloadOf<"link_dependency">, "kind" | "mirror">;

export type WaitingInput = {
  wait: WaitingWait;
  /** An existing wait (made in the dependency dialog, or seen by the pass): no wait step. */
  dependencyId: string | null;
  /** The owner as the card names them: a contact or a team; null for a wait with no owner. */
  ownerName: string | null;
  ownerChannel: "teams" | "email";
  /** The person owner's profile responsiveness (fast, normal, slow); null when unknown. */
  responsiveness: string | null;
  /** The usual chase interval, in working days. */
  followupDays: number;
  today: string;
  instructions: Instructions;
  /** The statuses of the ticket's project, in Jira's order; empty when not known. */
  statuses: readonly string[];
  /** The ticket's status now; null for a ticket not created yet or not cached. */
  targetStatus: string | null;
  found: Found | null;
  /** Something already went to the owner about it, or is about to, or the input was their own message. */
  askedAlready: boolean;
  /** The owner has a Confluence page or an email a mirrored wait can link to (D18). */
  mirrorFallback?: boolean;
};

export type WaitingPlaybook = {
  title: string;
  why: string;
  steps: StepDraft[];
  /** What the found-ticket choice rewrites (`foundEdits`). */
  facts: WaitingFacts;
};

/** What a later choice of the found ticket needs to rewrite the steps. */
export const WaitingFactsSchema = z.object({
  target: z.string(),
  /** The owner's name; empty for a wait with no owner. */
  owner: z.string(),
  label: z.string(),
  expectedAt: z.string().nullable().default(null),
  /** The wait's own reference and link, before any found ticket was put there. */
  externalRef: z.string().nullable().default(null),
  externalUrl: z.string().nullable().default(null),
  dependencyId: z.string().nullable().default(null),
  /** `mirrorWaits` was on, and whether the owner has a page or an email to link without a ticket. */
  mirror: z.boolean().default(false),
  mirrorFallback: z.boolean().default(false),
});
export type WaitingFacts = z.infer<typeof WaitingFactsSchema>;

/** A bundle record's facts as the waiting playbook wrote them, or null. */
export function waitingFactsOf(facts: unknown): WaitingFacts | null {
  const r = WaitingFactsSchema.safeParse(facts);
  return r.success ? r.data : null;
}

/**
 * Working days to the first follow-up when no date was given (D61): half the
 * usual interval for someone who answers fast, twice it for someone slow.
 */
export function responsivenessDays(responsiveness: string | null, followupDays: number): number {
  if (responsiveness === "fast") return Math.max(1, Math.ceil(followupDays / 2));
  if (responsiveness === "slow") return Math.min(30, followupDays * 2);
  return followupDays;
}

/** The first follow-up: the date asked for, else the working day after the expected date, else by responsiveness. */
export function firstFollowup(opts: {
  nextFollowupAt: string | null;
  expectedAt: string | null;
  responsiveness: string | null;
  followupDays: number;
  today: string;
}): string {
  return (
    nextFollowupAfter(opts) ??
    addBusinessDays(opts.today, responsivenessDays(opts.responsiveness, opts.followupDays))
  );
}

/** "Waiting on Sarah for the cert, expected 24 Oct, see PLAT-812." ("Waiting for ..." with no owner). */
export function waitComment(f: {
  owner: string | null;
  label: string;
  expectedAt: string | null;
  theirKey: string | null;
}): string {
  return `${f.owner ? `Waiting on ${f.owner} for` : "Waiting for"} ${f.label}${
    f.expectedAt ? `, expected ${dayLabel(f.expectedAt)}` : ""
  }${f.theirKey ? `, see ${f.theirKey}` : ""}.`;
}

/** The project's first status that reads Blocked, On hold or Waiting; null when it has none. */
export function blockedLikeStatus(statuses: readonly string[]): string | null {
  return statuses.find((s) => BLOCKED_STATUS.test(s)) ?? null;
}

const step = (
  payload: StoredProposalPayload,
  label: string,
  opts: { required?: boolean; choice?: boolean } = {},
): StepDraft => ({
  payload: payload as ProposalPayload,
  label,
  required: !!opts.required,
  choice: !!opts.choice,
});

/** The found ticket's key and link, for the wait's reference when it has none of its own. */
function refOf(found: Found | null, key: string | null) {
  const hit = key ? found?.results.find((r) => r.key === key) : undefined;
  return hit ? { externalRef: hit.key, externalUrl: hit.url } : null;
}

/** What the card says about the search. */
export function foundLine(found: Found | null, owner: string): string {
  if (!found) return "";
  if (found.projects.length === 0)
    return ` No Jira projects are on record for ${owner}, so their tickets were not searched.`;
  if (found.error) return ` ${found.error}.`;
  const n = found.results.length;
  const where = found.projects.join(", ");
  if (n === 0) return ` No open ticket in ${where} matches.`;
  return ` Found ${n} open ticket${n === 1 ? "" : "s"} in ${where}${
    found.picked ? `; ${found.picked} looks like theirs` : "; pick theirs, if one is"
  }.`;
}

/** Shown when `mirrorWaits` is on but nothing could be linked. */
export const NO_MIRROR_NOTE = "Not shown in Jira: no page or email to link.";

export function waitingPlaybook(input: WaitingInput): WaitingPlaybook {
  const { wait, instructions: on } = input;
  const owner = input.ownerName;
  const named = owner ?? wait.label;
  // A wait with no owner: no search, no request.
  const found = owner ? input.found : null;
  const picked = found?.picked ?? null;
  const fallback = !!input.mirrorFallback;
  const facts: WaitingFacts = {
    target: wait.target,
    owner: owner ?? "",
    label: wait.label,
    expectedAt: wait.expectedAt,
    externalRef: wait.externalRef,
    externalUrl: wait.externalUrl,
    dependencyId: input.dependencyId,
    mirror: on.mirrorWaits,
    mirrorFallback: fallback,
  };
  const steps: StepDraft[] = [];
  let noMirror = false;

  if (!input.dependencyId) {
    const next = firstFollowup({
      nextFollowupAt: wait.nextFollowupAt,
      expectedAt: wait.expectedAt,
      responsiveness: input.responsiveness,
      followupDays: input.followupDays,
      today: input.today,
    });
    // Their ticket becomes the wait's reference only when it has none of its own.
    const ref = wait.externalRef || wait.externalUrl ? null : refOf(found, picked);
    const url = ref?.externalUrl ?? wait.externalUrl;
    // Jira needs a URL on a remote link (D18): without one the wait is not mirrored.
    const mirror = on.mirrorWaits && (!!url || fallback);
    noMirror = on.mirrorWaits && !mirror && !(found?.results.some((r) => r.url) ?? false);
    steps.push(
      step(
        {
          kind: "link_dependency",
          ...wait,
          ...(ref ?? {}),
          nextFollowupAt: next,
          mirror,
        },
        `${owner ? `Wait on ${owner} for "${wait.label}"` : `Wait for "${wait.label}"`} on ${
          wait.target
        }${wait.expectedAt ? `, expected ${dayLabel(wait.expectedAt)}` : ""}; first follow-up ${dayLabel(
          next,
        )}${mirror ? "; shown in Jira" : ""}`,
        { required: true },
      ),
    );
  }

  const results = found?.results ?? [];
  const blocker = picked ?? results[0]?.key ?? null;
  if (on.linkFoundTickets && blocker && blocker !== wait.target)
    steps.push(
      step(
        { kind: "link_issues", target: wait.target, blocker },
        `${wait.target} is blocked by their ticket`,
        { choice: true },
      ),
    );

  if (on.commentWaits) {
    const body = waitComment({
      owner,
      label: wait.label,
      expectedAt: wait.expectedAt,
      theirKey: picked,
    });
    steps.push(
      step(
        { kind: "add_comment", target: wait.target, bodyMd: body },
        `Comment on ${wait.target}: "${body}"`,
      ),
    );
  }

  const blocked = blockedLikeStatus(input.statuses);
  if (on.blockedStatus && blocked && !BLOCKED_STATUS.test(input.targetStatus ?? ""))
    steps.push(
      step(
        { kind: "transition_issue", target: wait.target, toStatus: blocked },
        `Move ${wait.target} to ${blocked} while it waits`,
      ),
    );

  if (owner && on.draftRequests && !input.askedAlready && (wait.ownerPersonId || wait.ownerTeamId))
    steps.push(
      step(
        {
          kind: "draft_message",
          channel: input.ownerChannel,
          intent: "request",
          recipientPersonId: wait.ownerPersonId,
          recipientTeamId: wait.ownerPersonId ? null : wait.ownerTeamId,
          issueKeys: [wait.target],
          notes: `Ask ${owner} for ${wait.label} for ${wait.target}${
            wait.expectedAt ? `; it is needed by ${dayLabel(wait.expectedAt)}` : ""
          }.`,
          dependencyId: input.dependencyId,
          quote: null,
        },
        `Draft the request to ${owner}`,
      ),
    );

  return {
    title: owner ? `Waiting on ${owner}: ${wait.label}` : `Waiting for ${wait.label}`,
    why: `${wait.target} waits ${owner ? `on ${owner} ` : ""}for "${wait.label}"${
      wait.expectedAt ? `, expected ${dayLabel(wait.expectedAt)}` : ""
    }.${owner ? foundLine(found, named) : ""}${noMirror ? ` ${NO_MIRROR_NOTE}` : ""}`,
    steps,
    facts,
  };
}

/** A bundle step as `foundEdits` reads it: its seq, the payload that runs now, and whether it is the choice. */
export type ChoiceStep = { seq: number; payload: ProposalPayload; choice: boolean };

/**
 * What picking a found ticket (or "None of these") changes (Phase 26): the
 * link step's blocker, the wait's reference when the playbook put the ticket
 * there (never an incident number of its own) and whether it can be mirrored,
 * and the comment's "see KEY" while the user has not rewritten it. `skip`
 * holds the link step when nothing is picked: it is left out without a
 * correction.
 */
export function foundEdits(opts: {
  facts: WaitingFacts;
  found: Found;
  steps: readonly ChoiceStep[];
  choice: string | null;
}): { edits: Map<number, ProposalPayload>; skip: number[] } {
  const { facts, found, choice } = opts;
  const edits = new Map<number, ProposalPayload>();
  const skip: number[] = [];
  const keys = new Set(found.results.map((r) => r.key));
  const chosen = choice && keys.has(choice) ? choice : null;
  for (const s of opts.steps) {
    const p = s.payload;
    if (s.choice && p.kind === "link_issues") {
      if (!chosen) skip.push(s.seq);
      else if (p.blocker !== chosen) edits.set(s.seq, { ...p, blocker: chosen });
    } else if (p.kind === "link_dependency" && !facts.externalRef && !facts.externalUrl) {
      const ref = refOf(found, chosen);
      // Only a reference the playbook set (none, or a found ticket) is rewritten.
      if (p.externalRef && !keys.has(p.externalRef)) continue;
      const externalUrl = ref?.externalUrl ?? null;
      const next = {
        ...p,
        externalRef: ref?.externalRef ?? null,
        externalUrl,
        mirror: facts.mirror && (!!externalUrl || facts.mirrorFallback),
      };
      if (
        next.externalRef !== p.externalRef ||
        next.externalUrl !== p.externalUrl ||
        next.mirror !== p.mirror
      )
        edits.set(s.seq, next);
    } else if (p.kind === "add_comment") {
      const template = (theirKey: string | null) =>
        waitComment({
          owner: facts.owner || null,
          label: facts.label,
          expectedAt: facts.expectedAt,
          theirKey,
        });
      const generated = [null, ...keys].some((k) => template(k) === p.bodyMd.trim());
      const body = template(chosen);
      if (generated && body !== p.bodyMd) edits.set(s.seq, { ...p, bodyMd: body });
    }
  }
  return { edits, skip };
}

/**
 * What a revision of the thread hands back to classify for a bundled wait
 * (Phase 26): the proposal as the model made it, before the playbook added
 * the follow-up date, the mirror and the found ticket; when the user edited
 * it, their edit without a reference the search put there.
 */
export function revisionPayload(opts: {
  /** The payload that runs now (the user's edit, else as stored after expansion). */
  current: ProposalPayload;
  edited: boolean;
  /** The proposal before expansion, from the bundle record; null for older bundles. */
  origin: ProposalPayload | null;
  found: Found | null;
}): ProposalPayload {
  const { current, origin, found } = opts;
  if (!opts.edited && origin && origin.kind === current.kind) return origin;
  if (current.kind !== "link_dependency") return current;
  const searched = found?.results.find((r) => r.key === current.externalRef);
  return searched
    ? {
        ...current,
        externalRef: null,
        externalUrl: current.externalUrl === searched.url ? null : current.externalUrl,
      }
    : current;
}

/**
 * The classify correction of an approved, edited wait (Phase 26, D46): the
 * fields code set at expansion (follow-up date, mirror, the found reference)
 * are put back as the model had them unless the user changed them, so only
 * the user's own edit is learned.
 */
export function correctionAfter(opts: {
  stored: ProposalPayload;
  edited: ProposalPayload;
  origin: ProposalPayload;
}): ProposalPayload {
  const { stored, edited, origin } = opts;
  if (edited.kind !== "link_dependency" || origin.kind !== "link_dependency") return edited;
  if (stored.kind !== "link_dependency") return edited;
  const back = { ...edited };
  for (const f of ["nextFollowupAt", "mirror", "externalRef", "externalUrl"] as const)
    if (edited[f] === stored[f]) (back as Record<string, unknown>)[f] = origin[f];
  return back;
}

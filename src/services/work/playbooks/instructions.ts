/**
 * Standing instructions (FR-19.7, D61, Phase 26), pure: what each switch
 * means, which step it governs, and when a card offers to make a step the user
 * keeps leaving out the rule.
 *
 * Leaving the same step out of a playbook's cards twice (`step_left_out`
 * corrections with the same bundle kind and step kind) makes the next card of
 * that playbook ask once: "You left the comment out twice. Make that the
 * rule?" Yes turns the instruction off; No is recorded so it is not offered
 * again for that playbook and step. Only left-outs after the last answer count.
 */
import type { InstructionName, Instructions } from "@/services/settings/schema";

export type { InstructionName, Instructions };

/** Each switch in Settings > Secretary, with its one line. */
export const INSTRUCTION_LABELS: Record<InstructionName, { name: string; line: string }> = {
  mirrorWaits: {
    name: "Mirror waits into Jira",
    line: "Every new wait shows on its ticket in Jira as a link, kept up to date.",
  },
  blockedStatus: {
    name: "Move my ticket to Blocked while it waits",
    line: "When the project has a Blocked, On hold or Waiting status, and back when the wait ends.",
  },
  commentWaits: {
    name: "Comment on my ticket when a wait starts or ends",
    line: "Who and what it waits on and when, again when a chase is due, and when it is over or the ticket is done.",
  },
  linkFoundTickets: {
    name: "Link their ticket as a blocker",
    line: "When their ticket is found in their Jira projects, my ticket is blocked by it.",
  },
  draftRequests: {
    name: "Prepare the request message",
    line: "When the ask has not gone out yet, a draft to them waits on the Drafts page.",
  },
};

/** The step kind each instruction governs in the playbooks. */
export const STEP_INSTRUCTION: Readonly<Record<string, InstructionName>> = {
  add_comment: "commentWaits",
  transition_issue: "blockedStatus",
  link_issues: "linkFoundTickets",
  draft_message: "draftRequests",
};

/** How the offer names a step: "You left the comment out twice." */
export const STEP_NOUNS: Readonly<Record<string, string>> = {
  add_comment: "the comment",
  transition_issue: "the status change",
  link_issues: "the link to their ticket",
  draft_message: "the request draft",
};

/**
 * The steps of each playbook an instruction governs, so only those can be
 * offered: a chase draft left out says nothing about request drafts.
 */
export const OFFER_STEPS: Readonly<Record<string, readonly string[]>> = {
  waiting_on_someone: ["add_comment", "transition_issue", "link_issues", "draft_message"],
  wait_resolved: ["add_comment", "transition_issue"],
  wait_unanswered: ["add_comment"],
  ticket_done: ["add_comment"],
};

/** Left-outs before the offer. */
export const OFFER_AFTER = 2;

/** `memories` subject of an answer to the offer: `<playbook>:<step kind>`. */
export const offerSubject = (playbook: string, stepKind: string) => `${playbook}:${stepKind}`;

export type LeftOut = { rule: string; kind: string; at: string };
export type OfferAnswer = { subject: string; answer: "yes" | "no"; at: string };

export type InstructionOffer = {
  playbook: string;
  stepKind: string;
  instruction: InstructionName;
  count: number;
  /** "You left the comment out twice. Make that the rule?" */
  text: string;
};

const times = (n: number) => (n === 2 ? "twice" : `${n} times`);

/**
 * The offer a card of `playbook` makes, or null: the first step kind (in the
 * card's order) left out at least twice since the last answer, whose
 * instruction is still on and which was never answered No.
 */
export function instructionOffer(opts: {
  playbook: string;
  /** The step kinds of the card, in order. */
  stepKinds: readonly string[];
  leftOuts: readonly LeftOut[];
  answers: readonly OfferAnswer[];
  instructions: Instructions;
}): InstructionOffer | null {
  const governed = OFFER_STEPS[opts.playbook] ?? [];
  for (const stepKind of [...new Set(opts.stepKinds)]) {
    if (!governed.includes(stepKind)) continue;
    const instruction = STEP_INSTRUCTION[stepKind];
    if (!instruction || !opts.instructions[instruction]) continue;
    const subject = offerSubject(opts.playbook, stepKind);
    const answered = opts.answers.filter((a) => a.subject === subject);
    if (answered.some((a) => a.answer === "no")) continue;
    const since =
      answered
        .map((a) => a.at)
        .sort()
        .at(-1) ?? "";
    const count = opts.leftOuts.filter(
      (l) => l.rule === opts.playbook && l.kind === stepKind && l.at > since,
    ).length;
    if (count < OFFER_AFTER) continue;
    return {
      playbook: opts.playbook,
      stepKind,
      instruction,
      count,
      text: `You left ${STEP_NOUNS[stepKind] ?? "this step"} out ${times(count)}. Make that the rule?`,
    };
  }
  return null;
}

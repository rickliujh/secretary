import { describe, expect, test } from "bun:test";
import { snapshot } from "@/test/fixtures/intake/snapshot";
import {
  buildClassifyPrompt,
  buildItemSchema,
  type ItemOutput,
  validateItemOutput,
} from "./classify";
import { commentAudienceProblem, userAddressedPhrase } from "./comment-audience";

const e = { rationale: "r", evidence: "e", confidence: 0.9 };
const answer = (...proposals: Record<string, unknown>[]): ItemOutput => ({
  summary: "s",
  question: null,
  confidence: 0.9,
  proposals: proposals as ItemOutput["proposals"],
});

describe("classify_item: the comment rule and its check", () => {
  test("the rule is in the prompt and the body description", () => {
    expect(buildClassifyPrompt(snapshot).system).toContain(
      "An add_comment is text for the people who read the ticket in Jira, about the work. It is never a reply to the user",
    );
    const body = (
      buildItemSchema(snapshot).shape.proposals.element.shape as unknown as Record<
        string,
        { description?: string }
      >
    ).body;
    expect(body?.description).toContain("never a reply to the user");
    // Snapshots before version 12 replay without it.
    expect(buildClassifyPrompt({ ...snapshot, promptVersion: 11 }).system).not.toContain(
      "An add_comment is text for",
    );
  });

  test("a comment that answers the user goes to repair, telling the model to ask", () => {
    const out = answer({
      kind: "add_comment",
      target: "PAY-2",
      body: "I cannot estimate existing tickets. Please provide the story points you would like to assign to this task.",
      ...e,
    });
    const errors = validateItemOutput(out, snapshot);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toStartWith("Proposal 1 (add_comment): this comment talks to the user");
    expect(errors[0]).toContain("use question");
  });

  test("the user's own words exempt their phrases; pasted words do not", () => {
    const body = "I cannot estimate this until the API spec lands; story points to follow.";
    const out = answer({ kind: "add_comment", target: "PAY-2", body, ...e });
    const quote = `add a comment on PAY-2: ${body}`;
    expect(
      validateItemOutput(out, { ...snapshot, source: "typed", ownInput: true, quote }),
    ).toEqual([]);
    expect(
      validateItemOutput(out, {
        ...snapshot,
        thread: { instructions: [quote], decided: [], pending: [] },
      }),
    ).toEqual([]);
    // Pasted, the same words are someone else's: the comment goes to repair.
    expect(validateItemOutput(out, { ...snapshot, quote })).toHaveLength(1);
  });

  test("a closing reason and a status comment pass", () => {
    const close = answer(
      { kind: "transition_issue", target: "PAY-2", toStatus: "Done", ...e },
      {
        kind: "add_comment",
        target: "PAY-2",
        body: "Closed without being done: the payments team is relocating, so we won't do the ledger export anymore.",
        ...e,
      },
    );
    expect(validateItemOutput(close, snapshot)).toEqual([]);
    const status = answer({
      kind: "add_comment",
      target: "PAY-2",
      body: "The export is in review and should ship Thursday.",
      ...e,
    });
    expect(validateItemOutput(status, snapshot)).toEqual([]);
  });
});

describe("comments talk to the ticket's readers, never to the user", () => {
  test("bodies about points that tell the user what cannot be done, or ask them, are caught", () => {
    for (const body of [
      // What the model posted on GTCDSDP-22078.
      "I cannot estimate existing tickets. Please provide the story points you would like to assign to this task.",
      "Acknowledge the request for story points on GTCDSDP-22078.",
      // Close variants.
      "Story points cannot be estimated for existing tickets. What value should be assigned?",
      "Could you provide the story points you want for this task?",
      "Acknowledging your request to update the story points.",
      "I'm unable to set story points on an existing ticket.",
      "I am not able to change the estimate of this ticket.",
      "I won't re-estimate an existing ticket.",
      "Please provide the number of story points.",
      "Please let me know how many points you'd like.",
      "Which value would you like me to set for the story points?",
      "How many story points should this ticket have?",
      "As an AI assistant I do not estimate existing work.",
    ])
      expect({ body, phrase: userAddressedPhrase(body) }).toEqual({
        body,
        phrase: expect.any(String),
      });
  });

  test("comments the user dictates, closing reasons and ordinary comments pass", () => {
    for (const body of [
      // Dictated by the user: not about points, or a request addressed to a reader.
      "I can't update the schema until the DBA approves the migration.",
      "I'm unable to determine the root cause yet",
      "I cannot change the deadline without PM approval.",
      "Bob, please provide story points for the subtasks before planning.",
      "Would you like to use the old export in the meantime?",
      "Your request is noted; scheduled for next sprint.",
      "@ana could you re-estimate this once the API spec lands?",
      // Closing reasons (D43).
      "Closed as duplicate; acknowledged the request in PAY-9.",
      "Closed without being done: finance confirmed the rounding is expected behaviour, so there is nothing to fix.",
      "Cancelled: the payments team is relocating to the Lisbon office, so we won't do the ledger export anymore.",
      "Closed: we do not estimate spikes, and this one is finished.",
      // Status and requests to a reporter.
      "The rounding fix is in review and should ship Thursday.",
      "I can't reproduce this on staging; could you share the request ID?",
      "I cannot access the vendor portal until Monday, so the export waits until then.",
      "Please provide the logs from the failing run.",
      "Story points set to 3 after refinement with the team.",
      "Request received from finance: they need the export by the end of the month.",
    ])
      expect({ body, phrase: userAddressedPhrase(body) }).toEqual({ body, phrase: null });
  });

  test("a phrase the user wrote themselves is theirs to post", () => {
    const body = "I cannot estimate this until the API spec lands; story points to follow.";
    expect(userAddressedPhrase(body)).toBe("I cannot");
    expect(
      userAddressedPhrase(body, [
        "comment on PAY-4: I cannot estimate this until the API spec lands; story points to follow",
      ]),
    ).toBeNull();
    // Their words cover only the phrases they wrote.
    expect(
      userAddressedPhrase(`${body} Please provide the points you would like.`, [
        "comment on PAY-4: I cannot estimate this until the API spec lands",
      ]),
    ).toBe("Please provide");
  });

  test("the repair message names the phrase and says to ask instead", () => {
    const problem = commentAudienceProblem("I cannot estimate existing tickets.");
    expect(problem).toContain('("I cannot")');
    expect(problem).toContain("use question");
    expect(commentAudienceProblem("Fix is in review.")).toBeNull();
    expect(commentAudienceProblem(null)).toBeNull();
  });
});

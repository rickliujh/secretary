/** "Blocked by" links in classify_item (D45): the kind, its field, the rule and the checks. */
import { describe, expect, test } from "bun:test";
import type { z } from "zod";
import { snapshot } from "@/test/fixtures/intake/snapshot";
import {
  buildClassifyPrompt,
  buildItemSchema,
  CLASSIFY_PROMPT_VERSION,
  fromPayload,
  type ItemOutput,
  type ItemSnapshot,
  mapItemOutput,
  offeredKinds,
  validateItemOutput,
} from "./classify";

const withLinks: ItemSnapshot = {
  ...snapshot,
  blockLinkType: "Blocks",
  quote: "Once OPS-7 is done we can finish the ledger export (PAY-2).",
  candidates: snapshot.candidates.map((c) =>
    c.key === "OPS-7" ? { ...c, blockedBy: ["PAY-1"] } : c,
  ),
};
const e = { rationale: "r", evidence: "Once OPS-7 is done", confidence: 0.9 };
const link = { kind: "link_issues", target: "PAY-2", blocker: "OPS-7", ...e };
const answer = (...proposals: Record<string, unknown>[]): ItemOutput => ({
  summary: "s",
  question: null,
  confidence: 0.9,
  proposals: proposals as ItemOutput["proposals"],
});
const fields = (s: ItemSnapshot) =>
  buildItemSchema(s).shape.proposals.element.shape as unknown as Record<string, z.ZodType>;

describe("link_issues in the schema", () => {
  test("prompt version 8 or later", () => {
    expect(CLASSIFY_PROMPT_VERSION).toBeGreaterThanOrEqual(8);
  });

  test("without a blocks link type the kind, its field and its rule are absent", () => {
    expect(offeredKinds(snapshot)).not.toContain("link_issues");
    expect(fields(snapshot)).not.toHaveProperty("blocker");
    const { system } = buildClassifyPrompt(snapshot);
    expect(system).not.toContain("link_issues");
  });

  test("with one: the kind, a blocker from the candidates and $new refs, and the rule", () => {
    expect(offeredKinds(withLinks)).toContain("link_issues");
    const { blocker, kind } = fields(withLinks);
    if (!blocker || !kind) throw new Error("fields missing");
    expect(kind.parse("link_issues")).toBe("link_issues");
    expect(blocker.parse("OPS-7")).toBe("OPS-7");
    expect(blocker.parse("$new:1")).toBe("$new:1");
    expect(blocker.safeParse("PLAT-9").success).toBe(false);
    const { system, prompt } = buildClassifyPrompt(withLinks);
    expect(system).toContain('"when PLAT-1 is done", "after X ships"');
    expect(system).toContain("propose link_issues");
    // Existing links show on candidates, so they are not proposed again.
    expect(prompt).toContain("- OPS-7 [Task, To Do, assignee tom.k, blocked by PAY-1]");
  });

  test("a small ask's rule mentions the link when both are on", () => {
    const s: ItemSnapshot = {
      ...withLinks,
      smallAsks: {
        projectKey: "OPS",
        label: "small-ask",
        joinSprint: true,
        issueTypes: ["Task"],
        defaultType: "Task",
      },
    };
    expect(buildClassifyPrompt(s).system).toContain(
      "add a link_issues whose target is the new issue's ref and whose blocker is that ticket",
    );
  });
});

describe("validating and mapping link_issues", () => {
  const errorsOf = (...p: Record<string, unknown>[]) => validateItemOutput(answer(...p), withLinks);

  test("a link between two candidates maps to the canonical payload and back", () => {
    expect(errorsOf(link)).toEqual([]);
    const [m] = mapItemOutput(answer(link), withLinks.quote, withLinks);
    expect(m?.payload).toEqual({ kind: "link_issues", target: "PAY-2", blocker: "OPS-7" });
    if (!m) throw new Error("no proposal");
    expect(fromPayload(m.payload)).toEqual({
      kind: "link_issues",
      target: "PAY-2",
      blocker: "OPS-7",
    });
  });

  test("a new issue can wait on a candidate", () => {
    const create = {
      kind: "create_issue",
      ref: "$new:1",
      projectKey: "OPS",
      issueType: "Task",
      summary: "Tell the vendor",
      ...e,
    };
    expect(errorsOf(create, { ...link, target: "$new:1" })).toEqual([]);
    expect(errorsOf({ ...link, target: "$new:2" })).toContain(
      "Proposal 1 (link_issues): target $new:2 is not created by any create_issue in this answer.",
    );
  });

  test("both ends needed, from the candidates, different, not linked already, not mutual", () => {
    expect(errorsOf({ ...link, blocker: null })).toContain(
      "Proposal 1 (link_issues): link_issues needs blocker.",
    );
    expect(errorsOf({ ...link, blocker: "PLAT-9" })).toContain(
      "Proposal 1 (link_issues): blocker PLAT-9 is not one of the candidate issues.",
    );
    expect(errorsOf({ ...link, blocker: "PAY-2" })).toContain(
      "Proposal 1 (link_issues): an issue cannot be blocked by itself.",
    );
    expect(errorsOf({ ...link, target: "OPS-7", blocker: "PAY-1" })).toContain(
      "Proposal 1 (link_issues): OPS-7 is already blocked by PAY-1 in Jira; leave it out.",
    );
    expect(errorsOf(link, { ...link, target: "OPS-7", blocker: "PAY-2" })).toContain(
      "Proposal 1 (link_issues): PAY-2 and OPS-7 cannot block each other.",
    );
    expect(errorsOf(link, link)).toContain(
      "Proposal 2 (link_issues): PAY-2 blocked by OPS-7 is proposed twice.",
    );
  });

  test("a link proposed without the link type known is a kind the schema does not offer", () => {
    expect(fields(snapshot).kind?.safeParse("link_issues").success).toBe(false);
  });
});

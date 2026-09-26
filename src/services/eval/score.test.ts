import { describe, expect, test } from "bun:test";
import { ProposalPayloadSchema } from "@/services/proposals/schema";
import { replayAgreement, scoreCase, signature } from "./score";

const p = (x: Record<string, unknown>) => ProposalPayloadSchema.parse(x);

describe("eval scoring", () => {
  const actual = [
    p({ kind: "add_comment", target: "PAY-4", bodyMd: "x" }),
    p({
      kind: "create_issue",
      ref: "$new:1",
      projectKey: "PAY",
      issueType: "Story",
      summary: "s",
      epic: "PAY-1",
    }),
  ];

  test("an expected date must match the proposal's date", () => {
    const update = [
      p({ kind: "update_issue", target: "PAY-4", changes: { dueDate: "2026-11-09" } }),
    ];
    const want = (date: string) => ({
      required: [{ kind: "update_issue" as const, target: "PAY-4", date }],
    });
    expect(scoreCase(want("2026-11-09"), update).pass).toBe(true);
    expect(scoreCase(want("2026-10-26"), update).pass).toBe(false);
  });

  test("required kinds and targets must all be present", () => {
    expect(
      scoreCase(
        {
          required: [
            { kind: "add_comment", target: "PAY-4" },
            { kind: "create_issue", target: "PAY-1" },
          ],
        },
        actual,
      ).pass,
    ).toBe(true);
    const r = scoreCase({ required: [{ kind: "add_comment", target: "PAY-2" }] }, actual);
    expect(r.pass).toBe(false);
    expect(r.missing).toEqual([{ kind: "add_comment", target: "PAY-2" }]);
  });

  test("forbidden kinds fail the case", () => {
    expect(scoreCase({ required: [], forbiddenKinds: ["create_issue"] }, actual).forbidden).toEqual(
      ["create_issue"],
    );
  });

  test("signatures ignore order and questions", () => {
    expect(signature([...actual].reverse())).toBe(
      signature([...actual, p({ kind: "needs_clarification", question: "?" })]),
    );
  });

  test("replay agreement counts matches per kind and repeated rejections", () => {
    const comment = p({ kind: "add_comment", target: "PAY-4", bodyMd: "x" });
    const move = p({ kind: "transition_issue", target: "PAY-2", toStatus: "Done" });
    expect(
      replayAgreement([
        { done: [comment], rejected: [move], got: [comment, move] },
        { done: [comment], rejected: [], got: [] },
      ]),
    ).toEqual([
      { kind: "add_comment", approved: 2, matched: 1, repeatedRejections: 0 },
      { kind: "transition_issue", approved: 0, matched: 0, repeatedRejections: 1 },
    ]);
  });
});

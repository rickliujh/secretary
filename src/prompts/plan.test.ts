import { describe, expect, test } from "bun:test";
import type { Candidate } from "@/services/planning/logic";
import { buildPlanPrompt, buildPlanSchema, type PlanContext, validatePlan } from "./plan";

const cand = (key: string, p: Partial<Candidate> = {}): Candidate => ({
  key,
  summary: `${key} summary`,
  group: "backlog",
  issueType: "Story",
  status: "To Do",
  priority: "Medium",
  points: 3,
  dueDate: null,
  epicKey: null,
  blocked: [],
  dueInSprint: false,
  ...p,
});

const ctx: PlanContext = {
  today: "2026-09-25",
  next: { name: "Payments 16", start: "2026-09-28", end: "2026-10-12" },
  ending: { name: "Payments 15", end: "2026-09-28" },
  capacity: 8,
  velocity: {
    sprints: [{ name: "Payments 14", points: 8, issues: 3, unestimated: 0 }],
    average: 8,
  },
  candidates: [
    cand("PAY-1", { group: "carry_over", points: 5 }),
    cand("PAY-2", { group: "carry_over", points: 2 }),
    cand("PAY-3", { points: 3, blocked: ["OPS-7"] }),
    cand("PAY-4", { points: 8 }),
  ],
  instructions: ["keep Friday free for the release"],
};

describe("plan_sprint prompt (D30)", () => {
  test("schema only allows candidate keys", () => {
    const schema = buildPlanSchema(ctx.candidates.map((c) => c.key));
    expect(
      schema.safeParse({
        goal: "g",
        picks: [{ key: "PAY-9", reason: "r" }],
        deferred: [],
        risks: [],
      }).success,
    ).toBe(false);
  });

  test("a good plan passes; carry-overs must be decided, capacity kept, blocked picks named", () => {
    const good = {
      goal: "Ship the export",
      picks: [
        { key: "PAY-1", reason: "nearly done" },
        { key: "PAY-3", reason: "due" },
      ],
      deferred: [{ key: "PAY-2", reason: "waiting on design" }],
      risks: ["PAY-3 waits on OPS-7"],
    };
    expect(validatePlan(good, ctx)).toEqual([]);
    expect(
      validatePlan(
        {
          ...good,
          picks: [...good.picks, { key: "PAY-4", reason: "big" }],
          deferred: [],
          risks: [],
        },
        ctx,
      ),
    ).toEqual([
      "Decide these unfinished tickets (pick or defer): PAY-2.",
      "The picks add up to 16 points; the capacity is 8 (at most 9.2). Drop or defer some.",
      "PAY-3 is blocked (OPS-7); name it in risks.",
    ]);
    expect(
      validatePlan({ ...good, deferred: [...good.deferred, { key: "PAY-4", reason: "x" }] }, ctx),
    ).toContain(
      "Only unfinished tickets from the ending sprint can be deferred; PAY-4 is not one.",
    );
  });

  test("prompt groups candidates, marks ticket text untrusted and passes the user's notes", () => {
    const { system, prompt } = buildPlanPrompt(ctx);
    expect(system).toContain("Decide every unfinished ticket");
    expect(prompt).toContain("### Unfinished in the ending sprint (decide each: pick or defer)");
    expect(prompt).toContain("PAY-3 [Story, To Do, Medium, 3 pts, blocked by OPS-7] PAY-3 summary");
    expect(prompt).toContain('<untrusted_input source="jira">');
    expect(prompt).toContain("8 story points");
    expect(prompt).toContain("1. keep Friday free for the release");
  });
});

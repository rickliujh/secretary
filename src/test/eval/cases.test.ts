import { describe, expect, test } from "bun:test";
import { fixtureIssues } from "@/test/seed";
import { EVAL_CASES, EVAL_OUTSIDE_ISSUES } from "./cases";

describe("eval cases", () => {
  test("every expected issue target exists in the fixtures or is served from outside", () => {
    const keys = new Set([...fixtureIssues.map((i) => i.key), ...Object.keys(EVAL_OUTSIDE_ISSUES)]);
    for (const c of EVAL_CASES) {
      for (const r of c.expect.required) {
        if (r.target?.match(/^[A-Z]+-\d+$/)) expect(keys.has(r.target)).toBe(true);
        const blocker = r.fields?.blocker;
        if (typeof blocker === "string") expect(keys.has(blocker)).toBe(true);
      }
    }
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(5);
  });

  test("small-ask cases run with a home and check what code decides (D44)", () => {
    const small = EVAL_CASES.filter((c) => c.home);
    expect(small.length).toBeGreaterThanOrEqual(4);
    // Every small-ask case says whether the create is a small ask.
    for (const c of small)
      expect(
        c.expect.required.some((r) => r.kind === "create_issue" && "smallAsk" in (r.fields ?? {})),
      ).toBe(true);
    expect(small.some((c) => c.requester && c.sender === c.requester)).toBe(true);
  });

  test("blocker cases: a small ask blocked by an outside ticket, and two existing ones (D45)", () => {
    const links = EVAL_CASES.filter((c) => c.expect.required.some((r) => r.kind === "link_issues"));
    expect(links.length).toBeGreaterThanOrEqual(2);
    expect(links.some((c) => c.home && c.text.includes("PLAT-1"))).toBe(true);
    // PLAT-1 is not a synced fixture: the eval reads it once from Jira.
    expect(fixtureIssues.some((i) => i.key === "PLAT-1")).toBe(false);
  });
});

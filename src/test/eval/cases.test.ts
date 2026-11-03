import { describe, expect, test } from "bun:test";
import { fixtureIssues } from "@/test/seed";
import { contactTarget, EVAL_CASES, EVAL_OUTSIDE_ISSUES, workItemKeys } from "./cases";

describe("eval cases", () => {
  test("every expected issue target exists in the fixtures or is served from outside", () => {
    const keys = new Set([...fixtureIssues.map((i) => i.key), ...Object.keys(EVAL_OUTSIDE_ISSUES)]);
    for (const c of EVAL_CASES) {
      const own = new Set([...keys, ...workItemKeys(c)]);
      for (const r of [...c.expect.required, ...(c.expect.anyOf ?? []).flat()]) {
        if (r.target?.match(/^[A-Z]+-\d+$/)) expect(own.has(r.target)).toBe(true);
      }
      for (const r of c.expect.required) {
        const blocker = r.fields?.blocker;
        if (typeof blocker === "string") expect(keys.has(blocker)).toBe(true);
      }
    }
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(5);
  });

  test("a reply with a paste inside its sentence (D56)", () => {
    const inline = EVAL_CASES.filter((c) =>
      c.followUpParts?.some((p, i, all) => p.type === "pasted" && all[i - 1]?.type === "typed"),
    );
    expect(inline).toHaveLength(1);
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

  test("story point cases: stated, suggested, an existing ticket re-estimated, and an answer (D55)", () => {
    const fieldOf = (kind: string, field: string) =>
      EVAL_CASES.filter((c) =>
        c.expect.required.some((r) => r.kind === kind && field in (r.fields ?? {})),
      );
    expect(fieldOf("create_issue", "storyPointsEstimated")).toHaveLength(2);
    const update = fieldOf("update_issue", "storyPoints");
    expect(update).toHaveLength(2);
    // The fixture ticket has other points now, so each update changes something.
    for (const c of update) {
      const r = c.expect.required[0];
      const issue = fixtureIssues.find((i) => i.key === r?.target) as
        | { fields: Record<string, unknown> }
        | undefined;
      expect(issue?.fields.customfield_10106).not.toBe(r?.fields?.storyPoints);
    }
    // The answer arrives as a bare number in a follow-up, with no comment on the ticket.
    const answered = update.find((c) => c.followUp);
    expect(answered?.followUp).toMatch(/^\d+$/);
    expect(answered?.expect.forbiddenKinds).toContain("add_comment");
  });

  test("contact cases: an explicit add, a team plus contact, an unknown owner, no duplicate, no bystanders (D60)", () => {
    const cases = EVAL_CASES.filter((c) => c.name.startsWith("contacts:"));
    expect(cases).toHaveLength(5);
    const requires = (kind: string) =>
      cases.filter((c) => c.expect.required.some((r) => r.kind === kind));
    const forbids = (kind: "create_person") =>
      cases.filter((c) => c.expect.forbiddenKinds?.includes(kind));
    expect(requires("create_team")).toHaveLength(1);
    expect(requires("create_person")).toHaveLength(3);
    // The wait on a new contact names the contact's ref; the existing one's id.
    const owners = cases.flatMap((c) =>
      c.expect.required.flatMap((r) =>
        r.kind === "link_dependency" ? [r.fields?.ownerPersonId] : [],
      ),
    );
    expect(owners).toEqual(["$person:1", contactTarget("ana")]);
    expect(forbids("create_person")).toHaveLength(2);
    // Pasted text, not the user's own words, in the cases that may add nobody.
    for (const c of forbids("create_person")) expect(c.source).not.toBe("typed");
  });

  test("wait cases: an answer resolves a wait, a partial one logs a reply, an out-of-office sets the date (D46, D47)", () => {
    const actionOf = (action: string) =>
      EVAL_CASES.filter(
        (c) =>
          c.wait &&
          c.expect.required.some(
            (r) =>
              r.kind === "update_dependency" &&
              r.target === c.wait?.issueKey &&
              r.fields?.action === action,
          ),
      );
    expect(actionOf("resolve")).toHaveLength(1);
    expect(actionOf("log_reply")).toHaveLength(1);
    const away = EVAL_CASES.filter((c) =>
      c.expect.required.some((r) => r.kind === "update_person" && "awayUntil" in (r.fields ?? {})),
    );
    // One "until" notice and one "back on" notice.
    expect(away).toHaveLength(2);
    // The person is the sender, named by the run's contact id.
    for (const c of away)
      expect(c.expect.required[0]?.target).toBe(contactTarget(c.sender ?? "ana"));
    for (const c of EVAL_CASES.filter((x) => x.wait))
      expect(fixtureIssues.some((i) => i.key === c.wait?.issueKey)).toBe(true);
  });
});

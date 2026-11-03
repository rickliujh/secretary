/** Playbooks and standing instructions (FR-19.7, Phase 26): the pure parts. */
import { describe, expect, test } from "bun:test";
import { addBusinessDays } from "@/lib/dates";
import { mergeInferred, withInferredOff, withUserProjects } from "@/services/directory/projects";
import {
  type ProposalPayload,
  ProposalPayloadSchema,
  type StoredProposalPayload,
} from "@/services/proposals/schema";
import { defaultSettings, type Instructions } from "@/services/settings/schema";
import type { Found } from "../schema";
import { instructionOffer, type LeftOut, type OfferAnswer } from "./instructions";
import { resolvedPlaybook } from "./resolved";
import {
  buildWaitSearchJql,
  jqlText,
  ownerProjects,
  preselect,
  scoreFound,
  searchWords,
} from "./search";
import {
  blockedLikeStatus,
  correctionAfter,
  firstFollowup,
  foundEdits,
  responsivenessDays,
  revisionPayload,
  type WaitingInput,
  waitComment,
  waitingPlaybook,
} from "./waiting";

const TODAY = "2026-10-19";
const ON: Instructions = defaultSettings().secretary.instructions;
const kinds = (steps: { payload: ProposalPayload }[]) => steps.map((s) => s.payload.kind);
const valid = (steps: { payload: ProposalPayload }[]) =>
  steps.every((s) => ProposalPayloadSchema.safeParse(s.payload).success);

describe("find their ticket: the JQL (Phase 26)", () => {
  test("the owner's projects, open tickets, the label's words, newest first", () => {
    expect(buildWaitSearchJql({ projects: ["PLAT", "OPS"], label: "the payments cert" })).toBe(
      'project in (PLAT, OPS) AND statusCategory != Done AND text ~ "payments cert" ORDER BY updated DESC',
    );
  });

  test("stop words, short words and numbers are left out", () => {
    expect(searchWords("I'm waiting on Sarah for the new cert from 2026 to me")).toEqual([
      "waiting",
      "sarah",
      "new",
      "cert",
    ]);
  });

  test("nothing in a label can break out of the string or be an operator", () => {
    const jql = buildWaitSearchJql({
      projects: ["PLAT"],
      label: 'cert" OR project = SECRET -- (renewal*) AND key:x\\y',
    });
    expect(jql).toBe(
      'project in (PLAT) AND statusCategory != Done AND text ~ "cert project secret renewal key" ORDER BY updated DESC',
    );
    expect(jqlText('a "quoted" back\\slash (x)')).toBe('"a \\"quoted\\" back\\\\slash x"');
  });

  test("no projects, or no words: no search", () => {
    expect(buildWaitSearchJql({ projects: [], label: "the payments cert" })).toBeNull();
    expect(buildWaitSearchJql({ projects: ["PLAT"], label: "the it" })).toBeNull();
    // A key that is no project key is dropped.
    expect(buildWaitSearchJql({ projects: ["plat; drop", "x"], label: "cert" })).toBeNull();
  });

  test("the person's projects, else their team's, else none", () => {
    const user = (key: string) => ({ key, by: "user" as const });
    const sync = (key: string) => ({ key, by: "sync" as const });
    expect(ownerProjects({ person: [sync("OPS"), user("PLAT")], team: [user("X")] })).toEqual([
      "PLAT",
      "OPS",
    ]);
    expect(ownerProjects({ person: [], team: [sync("PLAT")] })).toEqual(["PLAT"]);
    expect(ownerProjects({ person: null, team: null })).toEqual([]);
  });
});

describe("find their ticket: scoring and pre-selection", () => {
  const r = (key: string, summary: string) => ({ key, summary, status: "Open", url: null });

  test("a single result sharing two label stems is picked", () => {
    const scored = scoreFound("the payments cert", [
      r("PLAT-9", "Rotate the load balancer"),
      r("PLAT-812", "Renew the payments cert"),
    ]);
    expect(scored.map((x) => [x.key, x.score])).toEqual([
      ["PLAT-812", 2],
      ["PLAT-9", 0],
    ]);
    expect(preselect(scored)).toBe("PLAT-812");
  });

  test("a tie, or a single shared stem, picks nothing", () => {
    const tie = scoreFound("the payments cert", [
      r("PLAT-1", "Payments cert for staging"),
      r("PLAT-2", "Payment certs in prod"),
    ]);
    expect(preselect(tie)).toBeNull();
    expect(
      preselect(scoreFound("the cert", [r("PLAT-812", "Renew the payments cert")])),
    ).toBeNull();
    expect(preselect([])).toBeNull();
  });
});

const sarahWait = {
  target: "PAY-12",
  dependencyKind: "person" as const,
  label: "the payments cert",
  ownerPersonId: "c-sarah",
  ownerTeamId: null,
  externalRef: null,
  externalUrl: null,
  expectedAt: "2026-10-24",
  nextFollowupAt: null,
};

const found = (picked: string | null, keys = ["PLAT-812", "PLAT-9"]): Found => ({
  projects: ["PLAT"],
  error: null,
  results: keys.map((key) => ({
    key,
    summary: key === "PLAT-812" ? "Renew the payments cert" : "Something else",
    status: "In Progress",
    url: `https://jira.example.com/browse/${key}`,
    score: key === "PLAT-812" ? 2 : 0,
  })),
  picked,
});

const waiting = (p: Partial<WaitingInput> = {}): WaitingInput => ({
  wait: sarahWait,
  dependencyId: null,
  ownerName: "Sarah Chen",
  ownerChannel: "teams",
  responsiveness: null,
  followupDays: 3,
  today: TODAY,
  instructions: ON,
  statuses: ["Blocked", "Done", "In Progress", "To Do"],
  targetStatus: "In Progress",
  found: found("PLAT-812"),
  askedAlready: false,
  ...p,
});

describe('the "waiting on someone" playbook', () => {
  test("by default: the wait (mirrored), their ticket, the comment, the request; no Blocked", () => {
    const pb = waitingPlaybook(waiting());
    expect(kinds(pb.steps)).toEqual([
      "link_dependency",
      "link_issues",
      "add_comment",
      "draft_message",
    ]);
    expect(valid(pb.steps)).toBe(true);
    expect(pb.steps.map((s) => [s.required, !!s.choice])).toEqual([
      [true, false],
      [false, true],
      [false, false],
      [false, false],
    ]);
    expect(pb.steps[0]?.payload).toMatchObject({
      kind: "link_dependency",
      mirror: true,
      externalRef: "PLAT-812",
      externalUrl: "https://jira.example.com/browse/PLAT-812",
      nextFollowupAt: addBusinessDays("2026-10-24", 1),
    });
    expect(pb.steps[1]?.payload).toEqual({
      kind: "link_issues",
      target: "PAY-12",
      blocker: "PLAT-812",
    });
    expect(pb.steps[2]?.payload).toEqual({
      kind: "add_comment",
      target: "PAY-12",
      bodyMd: "Waiting on Sarah Chen for the payments cert, expected 24 Oct, see PLAT-812.",
    });
    expect(pb.steps[3]?.payload).toMatchObject({
      intent: "request",
      recipientPersonId: "c-sarah",
      recipientTeamId: null,
      issueKeys: ["PAY-12"],
    });
    expect(pb.why).toContain("PLAT-812 looks like theirs");
  });

  test("each switch takes its step out", () => {
    const off = (p: Partial<Instructions>) =>
      kinds(waitingPlaybook(waiting({ instructions: { ...ON, ...p } })).steps);
    expect(off({ commentWaits: false })).not.toContain("add_comment");
    expect(off({ linkFoundTickets: false })).not.toContain("link_issues");
    expect(off({ draftRequests: false })).not.toContain("draft_message");
    expect(
      waitingPlaybook(waiting({ instructions: { ...ON, mirrorWaits: false } })).steps[0]?.payload,
    ).toMatchObject({ mirror: false });
  });

  test("Blocked only when switched on and the project has a Blocked-like status", () => {
    const on = { ...ON, blockedStatus: true };
    const pb = waitingPlaybook(waiting({ instructions: on }));
    expect(pb.steps.find((s) => s.payload.kind === "transition_issue")?.payload).toEqual({
      kind: "transition_issue",
      target: "PAY-12",
      toStatus: "Blocked",
    });
    const noStatus = waitingPlaybook(
      waiting({ instructions: on, statuses: ["To Do", "In Progress", "Done"] }),
    );
    expect(kinds(noStatus.steps)).not.toContain("transition_issue");
    const already = waitingPlaybook(waiting({ instructions: on, targetStatus: "Blocked" }));
    expect(kinds(already.steps)).not.toContain("transition_issue");
    expect(blockedLikeStatus(["Done", "On Hold", "Waiting for customer"])).toBe("On Hold");
  });

  test("no request when it already went out, or when the input was their own message", () => {
    expect(kinds(waitingPlaybook(waiting({ askedAlready: true })).steps)).not.toContain(
      "draft_message",
    );
  });

  test("nothing picked: the link step stays, on the first result, and the comment names no ticket", () => {
    const pb = waitingPlaybook(waiting({ found: found(null) }));
    expect(pb.steps[1]?.payload).toMatchObject({ kind: "link_issues", blocker: "PLAT-812" });
    expect(pb.steps[0]?.payload).toMatchObject({ externalRef: null });
    expect((pb.steps[2]?.payload as { bodyMd?: string } | undefined)?.bodyMd).toBe(
      "Waiting on Sarah Chen for the payments cert, expected 24 Oct.",
    );
    // Nothing found, or no search: no link step.
    const none = waitingPlaybook(waiting({ found: { ...found(null), results: [] } }));
    expect(kinds(none.steps)).not.toContain("link_issues");
    expect(waitingPlaybook(waiting({ found: { ...found(null), projects: [] } })).why).toContain(
      "No Jira projects are on record for Sarah Chen",
    );
  });

  test("an existing wait (the dependency dialog) gets the chores without a wait step", () => {
    const pb = waitingPlaybook(waiting({ dependencyId: "w1" }));
    expect(kinds(pb.steps)).toEqual(["link_issues", "add_comment", "draft_message"]);
    expect(pb.steps.every((s) => !s.required)).toBe(true);
    expect(pb.steps[2]?.payload).toMatchObject({ dependencyId: "w1" });
  });

  test("the first follow-up: the expected date, else by the owner's responsiveness", () => {
    expect(responsivenessDays("fast", 3)).toBe(2);
    expect(responsivenessDays(null, 3)).toBe(3);
    expect(responsivenessDays("slow", 3)).toBe(6);
    const base = { nextFollowupAt: null, followupDays: 3, today: TODAY };
    expect(firstFollowup({ ...base, expectedAt: "2026-10-24", responsiveness: "slow" })).toBe(
      addBusinessDays("2026-10-24", 1),
    );
    expect(firstFollowup({ ...base, expectedAt: null, responsiveness: "slow" })).toBe(
      addBusinessDays(TODAY, 6),
    );
    expect(
      firstFollowup({
        ...base,
        nextFollowupAt: "2026-10-21",
        expectedAt: null,
        responsiveness: null,
      }),
    ).toBe("2026-10-21");
  });
});

describe("picking a found ticket (foundEdits)", () => {
  const pb = waitingPlaybook(waiting());
  const steps = pb.steps.map((s, seq) => ({
    seq,
    payload: s.payload as ProposalPayload,
    choice: !!s.choice,
  }));

  test("another ticket: the link, the reference and the comment follow", () => {
    const r = foundEdits({ facts: pb.facts, found: found("PLAT-812"), steps, choice: "PLAT-9" });
    expect(r.skip).toEqual([]);
    expect(r.edits.get(1)).toMatchObject({ blocker: "PLAT-9" });
    expect(r.edits.get(0)).toMatchObject({ externalRef: "PLAT-9" });
    expect((r.edits.get(2) as { bodyMd: string }).bodyMd).toContain("see PLAT-9.");
  });

  test("none of these: the link is skipped, the reference cleared, the comment names none", () => {
    const r = foundEdits({ facts: pb.facts, found: found("PLAT-812"), steps, choice: null });
    expect(r.skip).toEqual([1]);
    expect(r.edits.get(0)).toMatchObject({ externalRef: null, externalUrl: null });
    expect((r.edits.get(2) as { bodyMd: string }).bodyMd).not.toContain("see");
  });

  test("the code's own pick changes nothing; a comment the user rewrote is kept", () => {
    expect(
      foundEdits({ facts: pb.facts, found: found("PLAT-812"), steps, choice: "PLAT-812" }).edits
        .size,
    ).toBe(0);
    const rewritten = steps.map((s) =>
      s.payload.kind === "add_comment"
        ? { ...s, payload: { ...s.payload, bodyMd: "Sarah is on it." } }
        : s,
    );
    const r = foundEdits({
      facts: pb.facts,
      found: found("PLAT-812"),
      steps: rewritten,
      choice: "PLAT-9",
    });
    expect(r.edits.has(2)).toBe(false);
  });

  test("a wait with its own reference keeps it", () => {
    const own = waitingPlaybook(waiting({ wait: { ...sarahWait, externalRef: "INC0012345" } }));
    expect(own.steps[0]?.payload).toMatchObject({ externalRef: "INC0012345" });
    const ownSteps = own.steps.map((s, seq) => ({
      seq,
      payload: s.payload as ProposalPayload,
      choice: !!s.choice,
    }));
    const r = foundEdits({
      facts: own.facts,
      found: found("PLAT-812"),
      steps: ownSteps,
      choice: null,
    });
    expect(r.edits.has(0)).toBe(false);
  });

  test("the template", () => {
    expect(
      waitComment({ owner: "Platform", label: "the cert", expectedAt: null, theirKey: null }),
    ).toBe("Waiting on Platform for the cert.");
  });
});

describe('the "wait resolved" playbook', () => {
  const resolve = ProposalPayloadSchema.parse({
    kind: "update_dependency",
    dependencyId: "w1",
    action: "resolve",
    summary: "Sarah sent it",
    issueKey: "PAY-12",
    label: "the payments cert",
  } satisfies StoredProposalPayload);
  if (resolve.kind !== "update_dependency") throw new Error("payload");
  const base = {
    resolve,
    wait: {
      id: "w1",
      issueKey: "PAY-12",
      label: "the payments cert",
      ownerName: "Sarah Chen",
      blocked: { issueKey: "PAY-12", from: "In Progress", to: "Blocked" },
    },
    targetStatus: "Blocked",
    otherOpenWaits: 0,
    instructions: ON,
  };

  test("resolve, say so, and move the ticket back out of Blocked", () => {
    const pb = resolvedPlaybook(base);
    expect(kinds(pb.steps)).toEqual(["update_dependency", "add_comment", "transition_issue"]);
    expect(pb.steps.map((s) => s.required)).toEqual([true, false, false]);
    expect(pb.steps[1]?.payload).toMatchObject({
      bodyMd: "No longer waiting on Sarah Chen for the payments cert: it is done.",
    });
    expect(pb.steps[2]?.payload).toEqual({
      kind: "transition_issue",
      target: "PAY-12",
      toStatus: "In Progress",
    });
  });

  test("no move back when the playbook did not block it, or it moved on since", () => {
    expect(
      kinds(resolvedPlaybook({ ...base, wait: { ...base.wait, blocked: null } }).steps),
    ).toEqual(["update_dependency", "add_comment"]);
    expect(kinds(resolvedPlaybook({ ...base, targetStatus: "In Review" }).steps)).toEqual([
      "update_dependency",
      "add_comment",
    ]);
    expect(
      kinds(resolvedPlaybook({ ...base, instructions: { ...ON, commentWaits: false } }).steps),
    ).toEqual(["update_dependency", "transition_issue"]);
  });
});

describe('"make that the rule?" (standing instructions)', () => {
  const left = (kind: string, at: string, rule = "waiting_on_someone"): LeftOut => ({
    rule,
    kind,
    at,
  });
  const offer = (leftOuts: LeftOut[], answers: OfferAnswer[] = [], instructions = ON) =>
    instructionOffer({
      playbook: "waiting_on_someone",
      stepKinds: ["link_dependency", "add_comment", "draft_message"],
      leftOuts,
      answers,
      instructions,
    });

  test("after two left-outs of the same step on the same playbook", () => {
    expect(offer([left("add_comment", "2026-10-01")])).toBeNull();
    expect(
      offer([left("add_comment", "2026-10-01"), left("add_comment", "2026-10-02", "ticket_done")]),
    ).toBeNull();
    expect(offer([left("add_comment", "2026-10-01"), left("add_comment", "2026-10-02")])).toEqual({
      playbook: "waiting_on_someone",
      stepKind: "add_comment",
      instruction: "commentWaits",
      count: 2,
      text: "You left the comment out twice. Make that the rule?",
    });
  });

  test("not when the instruction is off already, not after No, and Yes counts only later ones", () => {
    const two = [left("add_comment", "2026-10-01"), left("add_comment", "2026-10-02")];
    expect(offer(two, [], { ...ON, commentWaits: false })).toBeNull();
    expect(
      offer(two, [{ subject: "waiting_on_someone:add_comment", answer: "no", at: "2026-09-01" }]),
    ).toBeNull();
    const yes = {
      subject: "waiting_on_someone:add_comment",
      answer: "yes" as const,
      at: "2026-10-03",
    };
    expect(offer(two, [yes])).toBeNull();
    expect(
      offer([...two, left("add_comment", "2026-10-04"), left("add_comment", "2026-10-05")], [yes])
        ?.count,
    ).toBe(2);
  });

  test("only steps an instruction governs on that playbook", () => {
    // A chase draft left out says nothing about request drafts.
    expect(
      instructionOffer({
        playbook: "wait_unanswered",
        stepKinds: ["draft_message", "update_dependency"],
        leftOuts: [
          left("draft_message", "2026-10-01", "wait_unanswered"),
          left("draft_message", "2026-10-02", "wait_unanswered"),
        ],
        answers: [],
        instructions: ON,
      }),
    ).toBeNull();
  });
});

describe("Jira projects of contacts and teams", () => {
  test("inferred entries are kept apart from the user's and replaced each sync", () => {
    const current = [
      { key: "PLAT", by: "user" as const },
      { key: "OLD", by: "sync" as const },
    ];
    expect(mergeInferred(current, ["PAY", "PLAT", "bad key"])).toEqual([
      { key: "PLAT", by: "user" },
      { key: "PAY", by: "sync" },
    ]);
  });

  test("the user's keys replace their own entries only", () => {
    expect(withUserProjects([{ key: "PAY", by: "sync" }], ["plat", "PAY", "x y"])).toEqual([
      { key: "PLAT", by: "user" },
      { key: "PAY", by: "user" },
    ]);
  });
});

describe("review fixes (Phase 26)", () => {
  test("no move back while another wait on the ticket is still open", () => {
    const resolve = ProposalPayloadSchema.parse({
      kind: "update_dependency",
      dependencyId: "w1",
      action: "resolve",
    } satisfies StoredProposalPayload);
    if (resolve.kind !== "update_dependency") throw new Error("payload");
    const pb = resolvedPlaybook({
      resolve,
      wait: {
        id: "w1",
        issueKey: "PAY-12",
        label: "the cert",
        ownerName: "Sarah Chen",
        blocked: { issueKey: "PAY-12", from: "In Progress", to: "Blocked" },
      },
      targetStatus: "Blocked",
      otherOpenWaits: 1,
      instructions: ON,
    });
    expect(kinds(pb.steps)).toEqual(["update_dependency", "add_comment"]);
  });

  test("a wait with no owner: the wait, the comment, the Blocked move; no search, no request", () => {
    const pb = waitingPlaybook(
      waiting({
        wait: {
          ...sarahWait,
          dependencyKind: "incident",
          label: "INC0012345",
          ownerPersonId: null,
          externalUrl: "https://snow.example.com/INC0012345",
        },
        ownerName: null,
        instructions: { ...ON, blockedStatus: true },
      }),
    );
    expect(kinds(pb.steps)).toEqual(["link_dependency", "add_comment", "transition_issue"]);
    expect(pb.steps[0]?.payload).toMatchObject({ mirror: true, externalRef: null });
    expect((pb.steps[1]?.payload as { bodyMd?: string } | undefined)?.bodyMd).toBe(
      "Waiting for INC0012345, expected 24 Oct.",
    );
    expect(pb.title).toBe("Waiting for INC0012345");
  });

  test("no mirror without a page, an email or a ticket to link; the card says so", () => {
    const pb = waitingPlaybook(waiting({ found: { ...found(null), results: [] } }));
    expect(pb.steps[0]?.payload).toMatchObject({ mirror: false });
    expect(pb.why).toContain("Not shown in Jira: no page or email to link.");
    // An email or a team page to link: mirrored.
    const page = waitingPlaybook(waiting({ found: null, mirrorFallback: true }));
    expect(page.steps[0]?.payload).toMatchObject({ mirror: true });
    // Picking none of the found tickets leaves nothing to link.
    const pb2 = waitingPlaybook(waiting());
    const steps = pb2.steps.map((s, seq) => ({
      seq,
      payload: s.payload as ProposalPayload,
      choice: !!s.choice,
    }));
    const r = foundEdits({ facts: pb2.facts, found: found("PLAT-812"), steps, choice: null });
    expect(r.edits.get(0)).toMatchObject({ mirror: false, externalRef: null });
  });

  test("a revision hands back the wait as the model made it, or the user's edit without the found ticket", () => {
    const pb = waitingPlaybook(waiting());
    const stored = pb.steps[0]?.payload as ProposalPayload;
    const origin = ProposalPayloadSchema.parse({ kind: "link_dependency", ...sarahWait });
    expect(
      revisionPayload({ current: stored, edited: false, origin, found: found("PLAT-812") }),
    ).toEqual(origin);
    const edited = { ...stored, label: "the renewed payments cert" } as ProposalPayload;
    expect(
      revisionPayload({ current: edited, edited: true, origin, found: found("PLAT-812") }),
    ).toMatchObject({ label: "the renewed payments cert", externalRef: null, externalUrl: null });
  });

  test("an edited wait is learned as the user changed it, not as the playbook filled it", () => {
    const pb = waitingPlaybook(waiting());
    const stored = pb.steps[0]?.payload as ProposalPayload;
    const origin = ProposalPayloadSchema.parse({ kind: "link_dependency", ...sarahWait });
    const edited = { ...stored, label: "the signed cert" } as ProposalPayload;
    expect(correctionAfter({ stored, edited, origin })).toEqual<unknown>({
      ...origin,
      label: "the signed cert",
    });
  });

  test("an inferred project the user removed is not searched and a sync does not add it back", () => {
    const current = [
      { key: "PLAT", by: "sync" as const, off: true },
      { key: "OPS", by: "sync" as const },
    ];
    expect(ownerProjects({ person: current, team: null })).toEqual(["OPS"]);
    expect(mergeInferred(current, ["PLAT", "OPS"])).toEqual([
      { key: "OPS", by: "sync" },
      { key: "PLAT", by: "sync", off: true },
    ]);
    expect(withInferredOff(current, "PLAT", false)).toEqual([
      { key: "PLAT", by: "sync" },
      { key: "OPS", by: "sync" },
    ]);
  });

  test("a search names at most ten projects", () => {
    const many = Array.from({ length: 14 }, (_, i) => `P${String.fromCharCode(65 + i)}`);
    expect(buildWaitSearchJql({ projects: many, label: "the cert" })).toContain(
      `project in (${many.slice(0, 10).join(", ")})`,
    );
  });
});

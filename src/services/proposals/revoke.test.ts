import { describe, expect, test } from "bun:test";
import {
  cascadeOf,
  type LocalRevokeData,
  localRevokeBlock,
  planEntry,
  planRevoke,
  REVOKE_COMMENT,
  type RevokeFacts,
  type RevokeSubject,
  revokeBlock,
} from "./revoke";
import { ProposalPayloadSchema, type StoredProposalPayload } from "./schema";

let seq = 0;
const subject = (
  payload: StoredProposalPayload,
  result: unknown,
  extra: Partial<RevokeSubject> = {},
): RevokeSubject => {
  seq++;
  const p = ProposalPayloadSchema.parse(payload);
  return {
    id: `p${seq}`,
    kind: p.kind,
    status: "executed",
    payload: p,
    result,
    seq,
    decidedAt: `2026-10-15T10:00:${String(seq).padStart(2, "0")}.000Z`,
    ...extra,
  };
};

const create = (result: unknown = { message: "Created PAY-12", issueKey: "PAY-12" }) =>
  subject(
    {
      kind: "create_issue",
      ref: "$new:1",
      projectKey: "PAY",
      issueType: "Task",
      summary: "Send Dana the numbers",
    },
    result,
  );

const createFacts = (f: Partial<Extract<RevokeFacts, { kind: "create_issue" }>> = {}) =>
  ({
    kind: "create_issue",
    exists: true,
    canDelete: true,
    subtasks: [],
    status: { name: "To Do", category: "new" },
    available: [
      { name: "In Progress", category: "indeterminate" },
      { name: "Done", category: "done" },
      { name: "Cancelled", category: "done" },
    ],
    statuses: [
      { name: "To Do", category: "new" },
      { name: "In Progress", category: "indeterminate" },
      { name: "Done", category: "done" },
      { name: "Cancelled", category: "done" },
    ],
    commented: false,
    ...f,
  }) satisfies RevokeFacts;

const ops = (e: { steps: { op: unknown }[] }) => e.steps.map((s) => s.op);

describe("revokeBlock: what stored data alone rules out (FR-14.5)", () => {
  test("only executed approvals, never a question", () => {
    expect(revokeBlock({ kind: "add_comment", status: "pending", result: null })).toContain(
      "Only an approval that ran",
    );
    expect(
      revokeBlock({ kind: "needs_clarification", status: "executed", result: { answer: "x" } }),
    ).toContain("nothing to undo");
  });

  test("kinds that need undo data say they were approved before it was recorded", () => {
    for (const kind of ["update_issue", "transition_issue", "add_comment", "link_issues"])
      expect(revokeBlock({ kind, status: "executed", result: { message: "x" } })).toContain(
        "before undo was recorded",
      );
    // A create, a wait, a memory and a draft need only the ids their results hold.
    expect(
      revokeBlock({ kind: "create_issue", status: "executed", result: { issueKey: "PAY-1" } }),
    ).toBeNull();
    expect(
      revokeBlock({ kind: "link_dependency", status: "executed", result: { dependencyId: "d" } }),
    ).toBeNull();
    expect(revokeBlock({ kind: "remember", status: "executed", result: {} })).toContain(
      "before undo",
    );
  });
});

describe("create_issue", () => {
  test("deleted when the user may delete issues", () => {
    const e = planEntry(create(), createFacts());
    expect(e.impossible).toBeNull();
    expect(ops(e)).toEqual([
      { kind: "jira", action: { kind: "delete_issue", issueKey: "PAY-12" } },
    ]);
    expect(e.steps[0]?.text).toBe("Delete PAY-12 in Jira");
  });

  test("otherwise commented on and moved to the cancel status", () => {
    const e = planEntry(create(), createFacts({ canDelete: false }));
    expect(ops(e)).toEqual([
      {
        kind: "jira",
        action: { kind: "add_comment", issueKey: "PAY-12", bodyMarkdown: REVOKE_COMMENT },
      },
      // A target, not a transition id: the id is chosen when the step runs.
      { kind: "transition_to", issueKey: "PAY-12", status: "Cancelled" },
    ]);
    expect(e.notes[0]).toContain("may not delete");
  });

  test("a ticket with sub-tasks is closed rather than deleted", () => {
    const e = planEntry(create(), createFacts({ subtasks: ["PAY-13", "PAY-14"] }));
    expect(e.steps.map((s) => (s.op.kind === "jira" ? s.op.action.kind : s.op.kind))).toEqual([
      "add_comment",
      "transition_to",
    ]);
    expect(e.notes[0]).toContain("has sub-tasks");
  });

  test("resumed: the comment and the move already done are not repeated", () => {
    const e = planEntry(
      create(),
      createFacts({
        canDelete: false,
        commented: true,
        status: { name: "Cancelled", category: "done" },
      }),
    );
    expect(e.steps).toEqual([]);
    expect(e.notes).toContain("PAY-12 is already Cancelled.");
    expect(planEntry(create(), createFacts({ exists: false })).notes).toEqual([
      "PAY-12 is already deleted.",
    ]);
  });

  test("no cancel or done transition: impossible, naming the available ones", () => {
    const e = planEntry(
      create(),
      createFacts({
        canDelete: false,
        available: [{ name: "In Progress", category: "indeterminate" }],
      }),
    );
    expect(e.impossible).toBe(
      "PAY-12 has no transition to a cancelled or done status from To Do (available: In Progress).",
    );
  });

  test("a create whose result holds no key cannot be revoked", () => {
    expect(planEntry(create({ message: "x" }), createFacts()).impossible).toContain("before undo");
  });
});

describe("the cascade (FR-14.4)", () => {
  test("what acts on the new ticket goes first, newest first; drafts and other tickets stay", () => {
    const c = create();
    const wait = subject(
      { kind: "link_dependency", target: "$new:1", dependencyKind: "team", label: "Finance" },
      { dependencyId: "d1" },
    );
    const comment = subject(
      { kind: "add_comment", target: "$new:1", bodyMd: "Started" },
      { undo: { kind: "add_comment", issueKey: "PAY-12", commentId: "9" } },
    );
    // Approved later, by key (from another turn's resolved payload).
    const move = subject(
      { kind: "transition_issue", target: "PAY-12", toStatus: "In Progress" },
      {
        undo: {
          kind: "transition_issue",
          issueKey: "PAY-12",
          fromStatus: "To Do",
          toStatus: "In Progress",
        },
      },
    );
    const draft = subject(
      { kind: "draft_message", channel: "teams", intent: "fyi", issueKeys: ["$new:1"] },
      { communicationId: "c1" },
    );
    const other = subject(
      { kind: "add_comment", target: "PAY-3", bodyMd: "x" },
      { undo: { kind: "add_comment", issueKey: "PAY-3", commentId: "1" } },
    );
    const pending = subject({ kind: "add_comment", target: "$new:1", bodyMd: "later" }, null, {
      status: "pending",
    });
    const revoked = subject(
      { kind: "add_comment", target: "$new:1", bodyMd: "gone" },
      { undo: { kind: "add_comment", issueKey: "PAY-12", commentId: "8" } },
      { status: "revoked" },
    );
    const all = [c, wait, comment, move, draft, other, pending, revoked];
    expect(cascadeOf(c, all).map((s) => s.id)).toEqual([move.id, comment.id, wait.id]);
  });

  test("a sub-task made under the new ticket goes with what acts on it, before the parent", () => {
    const c = create();
    const sub = subject(
      {
        kind: "create_issue",
        ref: "$new:2",
        projectKey: "PAY",
        issueType: "Sub-task",
        summary: "Part",
        parent: "$new:1",
      },
      { issueKey: "PAY-13" },
    );
    const onSub = subject(
      { kind: "add_comment", target: "$new:2", bodyMd: "x" },
      { undo: { kind: "add_comment", issueKey: "PAY-13", commentId: "5" } },
    );
    expect(cascadeOf(c, [c, sub, onSub]).map((s) => s.id)).toEqual([onSub.id, sub.id]);
  });

  test("the plan runs the cascade first; a member that cannot be undone is left and says why", () => {
    const c = create();
    const old = subject({ kind: "add_comment", target: "$new:1", bodyMd: "x" }, { message: "x" });
    const plan = planRevoke(c, [old], new Map([[c.id, createFacts()]]));
    expect(plan.impossible).toBeNull();
    expect(plan.entries.map((e) => e.proposalId)).toEqual([old.id, c.id]);
    expect(plan.entries[0]?.impossible).toContain("before undo");
  });
});

describe("Jira kinds", () => {
  test("add_comment deletes the comment; a gone comment is already undone", () => {
    const s = subject(
      { kind: "add_comment", target: "PAY-3", bodyMd: "x" },
      { undo: { kind: "add_comment", issueKey: "PAY-3", commentId: "77" } },
    );
    expect(ops(planEntry(s, { kind: "add_comment", exists: true }))).toEqual([
      { kind: "jira", action: { kind: "delete_comment", issueKey: "PAY-3", commentId: "77" } },
    ]);
    expect(planEntry(s, { kind: "add_comment", exists: false }).steps).toEqual([]);
  });

  const updated = subject(
    {
      kind: "update_issue",
      target: "PAY-3",
      changes: { priority: "High", dueDate: "2026-10-30", assignee: "me", summary: "New" },
    },
    {
      undo: {
        kind: "update_issue",
        issueKey: "PAY-3",
        before: { priority: "Low", dueDate: null, assignee: "tom.k", summary: "Old" },
        after: { priority: "High", dueDate: "2026-10-30", assignee: "me", summary: "New" },
      },
    },
  );

  test("update_issue writes back the earlier values", () => {
    const e = planEntry(updated, {
      kind: "update_issue",
      exists: true,
      values: { priority: "High", dueDate: "2026-10-30", assignee: "me", summary: "New" },
    });
    expect(ops(e)).toEqual([
      {
        kind: "jira",
        action: {
          kind: "update_fields",
          issueKey: "PAY-3",
          fields: { priority: "Low", dueDate: null, summary: "Old" },
        },
      },
      { kind: "jira", action: { kind: "assign", issueKey: "PAY-3", username: "tom.k" } },
    ]);
    expect(e.warnings).toEqual([]);
  });

  test("a field changed in Jira since is kept and named in a warning (FR-14.3)", () => {
    const e = planEntry(updated, {
      kind: "update_issue",
      exists: true,
      // Someone set the priority to Highest and reassigned it after the approval;
      // the summary is already back.
      values: { priority: "Highest", dueDate: "2026-10-30", assignee: "ana.b", summary: "Old" },
    });
    expect(ops(e)).toEqual([
      {
        kind: "jira",
        action: { kind: "update_fields", issueKey: "PAY-3", fields: { dueDate: null } },
      },
    ]);
    expect(e.warnings).toEqual([
      "The priority of PAY-3 was changed since (now Highest), so it stays as it is.",
      "The assignee of PAY-3 was changed since (now ana.b), so it stays as it is.",
    ]);
  });

  test("a priority that had no value stays, with a warning", () => {
    const s = subject(
      { kind: "update_issue", target: "PAY-3", changes: { priority: "High" } },
      {
        undo: {
          kind: "update_issue",
          issueKey: "PAY-3",
          before: { priority: null },
          after: { priority: "High" },
        },
      },
    );
    const e = planEntry(s, { kind: "update_issue", exists: true, values: { priority: "High" } });
    expect(e.steps).toEqual([]);
    expect(e.warnings[0]).toContain("had no value before");
  });

  const moved = subject(
    { kind: "transition_issue", target: "PAY-3", toStatus: "In Progress" },
    {
      undo: {
        kind: "transition_issue",
        issueKey: "PAY-3",
        fromStatus: "To Do",
        toStatus: "In Progress",
      },
    },
  );
  const tFacts = (f: Partial<Extract<RevokeFacts, { kind: "transition_issue" }>>) =>
    ({
      kind: "transition_issue",
      exists: true,
      status: "In Progress",
      available: ["To Do", "Done"],
      ...f,
    }) satisfies RevokeFacts;

  test("transition_issue moves back; a later move stays; no way back is impossible", () => {
    expect(ops(planEntry(moved, tFacts({})))).toEqual([
      { kind: "transition_to", issueKey: "PAY-3", status: "To Do" },
    ]);
    const later = planEntry(moved, tFacts({ status: "Done" }));
    expect(later.steps).toEqual([]);
    expect(later.warnings[0]).toContain("was moved since (now Done)");
    expect(planEntry(moved, tFacts({ status: "To Do" })).notes).toEqual([
      "PAY-3 is already in To Do.",
    ]);
    expect(planEntry(moved, tFacts({ available: ["Done"] })).impossible).toBe(
      "PAY-3 cannot move back to To Do from In Progress (available: Done).",
    );
  });

  const sprintMove = (previous: { id: number; name: string } | null | undefined) =>
    subject(
      { kind: "move_to_sprint", target: "PAY-3", sprintId: 44, sprintName: "Payments 16" },
      {
        undo: {
          kind: "move_to_sprint",
          issueKey: "PAY-3",
          moved: true,
          sprintId: 44,
          ...(previous === undefined ? {} : { previous }),
        },
      },
    );
  const sFacts = (f: Partial<Extract<RevokeFacts, { kind: "move_to_sprint" }>>) =>
    ({
      kind: "move_to_sprint",
      exists: true,
      current: { id: 44, name: "Payments 16" },
      previousState: "active",
      ...f,
    }) satisfies RevokeFacts;

  test("move_to_sprint goes back to the earlier sprint or the backlog; a closed one is impossible", () => {
    expect(ops(planEntry(sprintMove({ id: 42, name: "Payments 15" }), sFacts({})))).toEqual([
      {
        kind: "jira",
        action: {
          kind: "move_to_sprint",
          issueKey: "PAY-3",
          sprintId: 42,
          sprintName: "Payments 15",
        },
      },
    ]);
    expect(ops(planEntry(sprintMove(null), sFacts({})))).toEqual([
      { kind: "jira", action: { kind: "move_to_backlog", issueKey: "PAY-3" } },
    ]);
    expect(
      planEntry(sprintMove({ id: 42, name: "Payments 15" }), sFacts({ previousState: "closed" }))
        .impossible,
    ).toBe("Sprint Payments 15 has closed, so PAY-3 cannot go back to it.");
    expect(planEntry(sprintMove(undefined), sFacts({})).impossible).toContain("not recorded");
    // Moved again since: it stays.
    const since = planEntry(sprintMove(null), sFacts({ current: { id: 45, name: "Payments 17" } }));
    expect(since.steps).toEqual([]);
    expect(since.warnings[0]).toContain("was moved since (now in sprint Payments 17)");
    // Already back.
    expect(planEntry(sprintMove(null), sFacts({ current: null })).notes).toEqual([
      "PAY-3 is already in the backlog.",
    ]);
  });

  test("move_to_sprint that moved nothing has nothing to undo", () => {
    const s = subject(
      { kind: "move_to_sprint", target: "PAY-3", sprintId: 44, sprintName: "Payments 16" },
      { undo: { kind: "move_to_sprint", issueKey: "PAY-3", moved: false, sprintId: 44 } },
    );
    const e = planEntry(s, sFacts({}));
    expect(e.steps).toEqual([]);
    expect(e.impossible).toBeNull();
  });

  test("link_issues removes the link it made, not one that was there", () => {
    const s = (linkId: string | null) =>
      subject(
        { kind: "link_issues", target: "PAY-3", blocker: "PAY-4" },
        { undo: { kind: "link_issues", issueKey: "PAY-3", linkId } },
      );
    expect(ops(planEntry(s("10001"), { kind: "link_issues", exists: true }))).toEqual([
      { kind: "jira", action: { kind: "delete_issue_link", issueKey: "PAY-3", linkId: "10001" } },
    ]);
    const had = planEntry(s(null), { kind: "link_issues", exists: true });
    expect(had.steps).toEqual([]);
    expect(had.notes[0]).toContain("before the approval");
  });
});

describe("local kinds", () => {
  test("link_dependency deletes the wait", () => {
    const s = subject(
      { kind: "link_dependency", target: "PAY-3", dependencyKind: "team", label: "Finance export" },
      { dependencyId: "d1" },
    );
    const e = planEntry(s, { kind: "link_dependency", exists: true });
    expect(ops(e)).toEqual([{ kind: "delete_wait", dependencyId: "d1" }]);
    expect(e.steps[0]?.text).toBe("Delete the wait on Finance export");
  });

  const wait = { expectedAt: "2026-09-30", nextFollowupAt: null, notifiedOn: null };
  const before = { ...wait, status: "open" as const, resolvedAt: null };
  const after = { ...wait, status: "resolved" as const, resolvedAt: "2026-10-15T10:00:00.000Z" };
  const waitUpdate = subject(
    {
      kind: "update_dependency",
      dependencyId: "d1",
      action: "resolve",
      summary: "Arrived",
      label: "Vendor quote",
    },
    { undo: { kind: "update_dependency", dependencyId: "d1", before, after, followupId: "f1" } },
  );

  test("update_dependency restores the row and removes the timeline entry", () => {
    expect(
      ops(
        planEntry(waitUpdate, {
          kind: "update_dependency",
          // A reminder stamped notifiedOn since; that is not a change by the user.
          current: { ...after, notifiedOn: "2026-10-15" },
          followupExists: true,
        }),
      ),
    ).toEqual([{ kind: "restore_wait", dependencyId: "d1", state: before, followupId: "f1" }]);
  });

  test("a wait changed since keeps its state; only the entry goes", () => {
    const e = planEntry(waitUpdate, {
      kind: "update_dependency",
      current: { ...after, status: "open", resolvedAt: null, expectedAt: "2026-11-01" },
      followupExists: true,
    });
    expect(ops(e)).toEqual([
      { kind: "restore_wait", dependencyId: "d1", state: null, followupId: "f1" },
    ]);
    expect(e.warnings[0]).toContain("changed since");
  });

  test("update_person and update_team put back what they changed, unless changed since", () => {
    const person = subject(
      {
        kind: "update_person",
        personId: "u1",
        changes: { title: "Lead", awayUntil: "2026-10-20" },
      },
      {
        undo: {
          kind: "update_person",
          personId: "u1",
          before: { title: "Analyst", awayUntil: null },
          after: { title: "Lead", awayUntil: "2026-10-20" },
        },
      },
    );
    const e = planEntry(
      person,
      { kind: "update_person", current: { title: "Lead", awayUntil: "2026-10-25" } },
      { subject: () => "Dana" },
    );
    expect(ops(e)).toEqual([{ kind: "restore_person", personId: "u1", set: { title: "Analyst" } }]);
    expect(e.steps[0]?.text).toBe("Put back the title of Dana");
    expect(e.warnings).toEqual(["The away until of Dana was changed since, so it stays as it is."]);

    const team = subject(
      { kind: "update_team", teamId: "t1", changes: { channel: "#fin" } },
      {
        undo: {
          kind: "update_team",
          teamId: "t1",
          before: { channel: null },
          after: { channel: "#fin" },
        },
      },
    );
    expect(ops(planEntry(team, { kind: "update_team", current: { channel: "#fin" } }))).toEqual([
      { kind: "restore_team", teamId: "t1", set: { channel: null } },
    ]);
  });

  test("remember forgets the memory", () => {
    const s = subject({ kind: "remember", memoryKind: "fact", content: "x" }, { memoryId: "m1" });
    expect(ops(planEntry(s, { kind: "remember", exists: true }))).toEqual([
      { kind: "delete_memory", memoryId: "m1" },
    ]);
  });

  test("draft_message deletes a draft; a sent or copied one cannot be revoked", () => {
    const s = subject(
      { kind: "draft_message", channel: "email", intent: "chase" },
      { communicationId: "c1" },
    );
    expect(ops(planEntry(s, { kind: "draft_message", status: "draft" }))).toEqual([
      { kind: "delete_draft", communicationId: "c1" },
    ]);
    expect(planEntry(s, { kind: "draft_message", status: "sent" }).impossible).toContain(
      "already sent",
    );
    expect(planEntry(s, { kind: "draft_message", status: "copied" }).impossible).toContain(
      "already copied",
    );
  });

  test("facts of another kind (or none) make it impossible rather than guess", () => {
    const s = subject({ kind: "remember", memoryKind: "fact", content: "x" }, { memoryId: "m1" });
    expect(planEntry(s, null).impossible).toBe("Could not read what to undo.");
    expect(planEntry(s, { kind: "link_issues", exists: true }).impossible).toBe(
      "Could not read what to undo.",
    );
  });
});

describe("the cascade is planned against the state its earlier steps leave (D54)", () => {
  const transition = (from: string, to: string) =>
    subject(
      { kind: "transition_issue", target: "$new:1", toStatus: to },
      { undo: { kind: "transition_issue", issueKey: "PAY-12", fromStatus: from, toStatus: to } },
    );
  const plan = (
    c: RevokeSubject,
    members: RevokeSubject[],
    facts: [RevokeSubject, RevokeFacts][],
  ) => planRevoke(c, cascadeOf(c, [c, ...members]), new Map(facts.map(([s, f]) => [s.id, f])));
  const texts = (p: ReturnType<typeof planRevoke>) =>
    p.entries.flatMap((e) => e.steps.map((s) => s.text));

  test("a ticket moved to Done in a later turn goes back, then on to the cancel status", () => {
    const c = create();
    const done = transition("To Do", "Done");
    const nowDone = { name: "Done", category: "done" };
    const p = plan(
      c,
      [done],
      [
        [done, { kind: "transition_issue", exists: true, status: "Done", available: ["To Do"] }],
        // Read before any step runs: the ticket is Done, and from Done it can only reopen.
        [
          c,
          createFacts({
            canDelete: false,
            status: nowDone,
            available: [{ name: "To Do", category: "new" }],
          }),
        ],
      ],
    );
    expect(p.impossible).toBeNull();
    expect(texts(p)).toEqual([
      "Move PAY-12 back to To Do",
      `Comment on PAY-12: "${REVOKE_COMMENT}"`,
      "Move PAY-12 to Cancelled",
    ]);
    // Not "already Done": the step before moves it out of Done.
    expect(p.entries[1]?.notes).not.toContain("PAY-12 is already Done.");
    expect(p.entries[1]?.steps.at(-1)?.op).toEqual({
      kind: "transition_to",
      issueKey: "PAY-12",
      status: "Cancelled",
    });
  });

  test("two moves of the same ticket go back one after the other", () => {
    const c = create();
    const started = transition("To Do", "In Progress");
    const review = transition("In Progress", "In Review");
    // Both read now: the ticket is In Review.
    const facts = (s: RevokeSubject): [RevokeSubject, RevokeFacts] => [
      s,
      {
        kind: "transition_issue",
        exists: true,
        status: "In Review",
        available: ["In Progress", "Done"],
      },
    ];
    const p = plan(c, [started, review], [facts(started), facts(review), [c, createFacts()]]);
    expect(texts(p)).toEqual([
      "Move PAY-12 back to In Progress",
      "Move PAY-12 back to To Do",
      "Delete PAY-12 in Jira",
    ]);
    expect(p.entries.flatMap((e) => e.warnings)).toEqual([]);
  });

  test("two changes of the same field are put back in turn, to the first value", () => {
    const c = create();
    const update = (from: string, to: string) =>
      subject(
        { kind: "update_issue", target: "$new:1", changes: { priority: to } },
        {
          undo: {
            kind: "update_issue",
            issueKey: "PAY-12",
            before: { priority: from },
            after: { priority: to },
          },
        },
      );
    const medium = update("Low", "Medium");
    const high = update("Medium", "High");
    const now: RevokeFacts = { kind: "update_issue", exists: true, values: { priority: "High" } };
    const p = plan(
      c,
      [medium, high],
      [
        [medium, now],
        [high, now],
        [c, createFacts()],
      ],
    );
    expect(texts(p)).toEqual([
      "Set the priority back to Medium on PAY-12",
      "Set the priority back to Low on PAY-12",
      "Delete PAY-12 in Jira",
    ]);
    expect(p.entries.flatMap((e) => e.warnings)).toEqual([]);
  });

  test("a sub-task the cascade deletes first no longer keeps its parent from being deleted", () => {
    const c = create();
    const sub = subject(
      {
        kind: "create_issue",
        ref: "$new:2",
        projectKey: "PAY",
        issueType: "Sub-task",
        summary: "Part",
        parent: "$new:1",
      },
      { issueKey: "PAY-13" },
    );
    const p = plan(
      c,
      [sub],
      [
        [sub, createFacts()],
        [c, createFacts({ subtasks: ["PAY-13"] })],
      ],
    );
    expect(texts(p)).toEqual(["Delete PAY-13 in Jira", "Delete PAY-12 in Jira"]);
    // A sub-task that stays (it cannot be undone) still keeps the parent closed.
    const kept = plan(
      c,
      [sub],
      [[c, createFacts({ subtasks: ["PAY-13"] })]], // no facts for the sub-task: left
    );
    expect(texts(kept)).toEqual([
      `Comment on PAY-12: "${REVOKE_COMMENT}"`,
      "Move PAY-12 to Cancelled",
    ]);
  });

  test("a move from a status the cascade reaches first is not checked against today's transitions", () => {
    const c = create();
    const started = transition("To Do", "In Progress");
    const p = plan(
      c,
      [started],
      [
        [
          started,
          { kind: "transition_issue", exists: true, status: "In Progress", available: ["To Do"] },
        ],
        // From In Progress there is no cancel transition, but from To Do there may be:
        // the project's statuses decide, and the transition is chosen when the step runs.
        [
          c,
          createFacts({
            canDelete: false,
            status: { name: "In Progress", category: "indeterminate" },
            available: [{ name: "To Do", category: "new" }],
          }),
        ],
      ],
    );
    expect(p.impossible).toBeNull();
    expect(texts(p).at(-1)).toBe("Move PAY-12 to Cancelled");
  });

  test("two updates of the same wait restore the state before the first", () => {
    const state = (status: "open" | "waiting" | "resolved", expectedAt: string) => ({
      status,
      expectedAt,
      nextFollowupAt: null,
      resolvedAt: null,
      notifiedOn: null,
    });
    const a = state("open", "2026-10-01");
    const b = state("waiting", "2026-10-08");
    const c2 = state("waiting", "2026-10-20");
    const update = (before: typeof a, after: typeof a, followupId: string) =>
      subject(
        {
          kind: "update_dependency",
          dependencyId: "d1",
          action: "reschedule",
          expectedAt: after.expectedAt,
          label: "Finance",
        },
        { undo: { kind: "update_dependency", dependencyId: "d1", before, after, followupId } },
      );
    const first = update(a, b, "f1");
    const second = update(b, c2, "f2");
    const facts: RevokeFacts = { kind: "update_dependency", current: c2, followupExists: true };
    const p = planRevoke(
      first,
      [second],
      new Map([
        [first.id, facts],
        [second.id, facts],
      ]),
    );
    expect(p.entries.map((e) => e.steps[0]?.op)).toEqual([
      { kind: "restore_wait", dependencyId: "d1", state: b, followupId: "f2" },
      { kind: "restore_wait", dependencyId: "d1", state: a, followupId: "f1" },
    ]);
  });
});

describe("names and local blocks", () => {
  test("an assignee put back is named, not shown by user id", () => {
    const s = subject(
      { kind: "update_issue", target: "PAY-3", changes: { assignee: "acc-9" } },
      {
        undo: {
          kind: "update_issue",
          issueKey: "PAY-3",
          before: { assignee: "acc-1" },
          after: { assignee: "acc-9" },
          names: { "acc-1": "Tom Kay" },
        },
      },
    );
    const facts = (assignee: string): RevokeFacts => ({
      kind: "update_issue",
      exists: true,
      values: { assignee },
      userNames: { "acc-7": "Ana Bell" },
    });
    expect(planEntry(s, facts("acc-9")).steps[0]?.text).toBe("Assign PAY-3 back to Tom Kay");
    expect(planEntry(s, facts("acc-7")).warnings[0]).toBe(
      "The assignee of PAY-3 was changed since (now Ana Bell), so it stays as it is.",
    );
    // Old undo data without names: the caller's lookup, else the id.
    const old = subject(s.payload, {
      undo: {
        kind: "update_issue",
        issueKey: "PAY-3",
        before: { assignee: "acc-2" },
        after: { assignee: "acc-9" },
      },
    });
    expect(
      planEntry(old, facts("acc-9"), { user: (id) => (id === "acc-2" ? "Dana Lee" : null) })
        .steps[0]?.text,
    ).toBe("Assign PAY-3 back to Dana Lee");
    expect(planEntry(old, facts("acc-9")).steps[0]?.text).toBe("Assign PAY-3 back to acc-2");
  });

  test("a sent draft and a closed sprint are ruled out before the confirmation opens (FR-14.5)", () => {
    const local = (draft: string | null, sprint: string | null): LocalRevokeData => ({
      draftStatus: () => draft,
      sprintState: () => sprint,
    });
    const draft = { kind: "draft_message", status: "executed", result: { communicationId: "c1" } };
    expect(localRevokeBlock(draft, local("sent", null))).toContain("already sent");
    expect(localRevokeBlock(draft, local("copied", null))).toContain("already copied");
    expect(localRevokeBlock(draft, local("draft", null))).toBeNull();
    const sprint = {
      kind: "move_to_sprint",
      status: "executed",
      result: {
        undo: {
          kind: "move_to_sprint",
          issueKey: "PAY-3",
          moved: true,
          sprintId: 44,
          previous: { id: 42, name: "Payments 15" },
        },
      },
    };
    expect(localRevokeBlock(sprint, local(null, "closed"))).toBe(
      "Sprint Payments 15 has closed, so PAY-3 cannot go back to it.",
    );
    expect(localRevokeBlock(sprint, local(null, "active"))).toBeNull();
    // What stored data rules out comes first.
    expect(localRevokeBlock({ ...draft, status: "revoked" }, local("sent", null))).toBe(
      "It is already revoked.",
    );
  });
});

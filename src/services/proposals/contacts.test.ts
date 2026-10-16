/**
 * New contacts and teams from a thread (FR-18, D60), without Jira writes: refs
 * resolve to what the thread's creates made, a duplicate is refused at approval,
 * a move between teams, and revoking deletes them after what uses them, or says
 * why they stay.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import {
  communications,
  contextNotes,
  dependencies,
  inboxItems,
  memories,
  people,
  proposals,
  teams,
} from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { type Db, query } from "@/services/db";
import { createPerson, getTeam, listPeople, listTeams } from "@/services/directory/queries";
import { Executor } from "@/services/executor";
import { ExecutorLive } from "@/services/executor/live";
import { syncedJiraLayer, syncOnce } from "@/test/seed";
import { Proposals, type StoredProposalPayload } from ".";
import { ProposalsLive } from "./live";

const layer = () =>
  Layer.provideMerge(ProposalsLive, Layer.provideMerge(ExecutorLive, syncedJiraLayer().layer));

const run = <A>(program: Effect.Effect<A, unknown, Proposals | Executor | Db>) =>
  Effect.runPromise(
    Effect.provide(
      Effect.flatMap(syncOnce, () => program),
      layer(),
    ) as Effect.Effect<A, unknown, never>,
  );

/** A thread holding these proposals, pending, in order; returns their ids. */
const thread = (...payloads: StoredProposalPayload[]) =>
  Effect.gen(function* () {
    const inboxItemId = newId();
    yield* query((d) =>
      d.insert(inboxItems).values({
        id: inboxItemId,
        source: "typed",
        rawText: "x",
        receivedAt: nowIso(),
        status: "triaged",
      }),
    );
    const ids: string[] = [];
    for (const [seq, payload] of payloads.entries()) {
      const id = newId();
      ids.push(id);
      yield* query((d) =>
        d.insert(proposals).values({
          id,
          inboxItemId,
          seq,
          kind: payload.kind,
          payload,
          status: "pending",
          createdAt: nowIso(),
        }),
      );
    }
    return ids;
  });

const row = (id: string) =>
  Effect.map(
    query((d) => d.select().from(proposals).where(eq(proposals.id, id)).get()),
    (r) => r as typeof proposals.$inferSelect,
  );

const payments: StoredProposalPayload = {
  kind: "create_team",
  ref: "$team:1",
  name: "Payments",
  function: "Invoicing and refunds",
};
const sarah: StoredProposalPayload = {
  kind: "create_person",
  ref: "$person:1",
  displayName: "Sarah Lee",
  title: "Staff engineer",
  team: "$team:1",
  profile: { formality: "formal" },
  note: "Owns the signing certificates",
};
const waitOnSarah: StoredProposalPayload = {
  kind: "link_dependency",
  target: "PAY-2",
  dependencyKind: "person",
  label: "Signed certificate",
  ownerPersonId: "$person:1",
  expectedAt: "2026-09-25",
};
const draftToSarah: StoredProposalPayload = {
  kind: "draft_message",
  channel: "teams",
  intent: "request",
  recipientPersonId: "$person:1",
  notes: "Ask for the certificate",
};

describe("new contacts and teams (FR-18 AC)", () => {
  test("a team and a contact in it; what uses them waits for them, then gets their ids", async () => {
    const r = await run(
      Effect.gen(function* () {
        const svc = yield* Proposals;
        const [team, person, wait] = yield* thread(payments, sarah, waitOnSarah);
        // The wait needs Sarah, who is not added yet.
        const early = yield* svc.approve(wait ?? "");
        yield* svc.approve(team ?? "");
        const added = yield* svc.approve(person ?? "");
        const retried = yield* svc.approve(wait ?? "");
        const personId = ((yield* row(person ?? "")).result as { personId?: string }).personId;
        const teamId = ((yield* row(team ?? "")).result as { teamId?: string }).teamId;
        const dep = yield* query((d) =>
          d.select().from(dependencies).where(eq(dependencies.issueKey, "PAY-2")).all(),
        );
        return {
          early,
          added,
          retried,
          personId,
          teamId,
          people: yield* listPeople,
          teams: yield* listTeams,
          members: (yield* getTeam(teamId ?? ""))?.members.map((m) => m.displayName),
          dep,
        };
      }),
    );
    expect(r.early).toMatchObject({ status: "failed" });
    expect(r.early.message).toBe(
      "Approve the new contact Sarah Lee first; this proposal needs them.",
    );
    expect(r.added).toMatchObject({
      status: "executed",
      message: "Added Sarah Lee to your contacts",
    });
    expect(r.retried.status).toBe("executed");
    const s = r.people.find((p) => p.displayName === "Sarah Lee");
    expect(s).toMatchObject({
      id: r.personId,
      title: "Staff engineer",
      teamId: r.teamId,
      profile: { formality: "formal" },
    });
    expect(s?.notesMd).toContain("Owns the signing certificates");
    expect(r.teams.map((t) => t.name)).toContain("Payments");
    expect(r.members).toEqual(["Sarah Lee"]);
    expect(r.dep.find((d) => d.label === "Signed certificate")?.ownerPersonId).toBe(r.personId);
  });

  test("revoking a new team deletes the new contact in it first", async () => {
    const r = await run(
      Effect.gen(function* () {
        const svc = yield* Proposals;
        const [team, person] = yield* thread(payments, sarah);
        yield* svc.approve(team ?? "");
        yield* svc.approve(person ?? "");
        const plan = yield* svc.revokePlan(team ?? "");
        yield* svc.revoke(team ?? "");
        return {
          plan: plan.entries.flatMap((e) => e.steps.map((s) => s.text)),
          people: (yield* listPeople).map((p) => p.displayName),
          teams: (yield* listTeams).map((t) => t.name),
        };
      }),
    );
    expect(r.plan).toEqual(["Delete the contact Sarah Lee", "Delete the team Payments"]);
    expect(r.people).toEqual([]);
    expect(r.teams).toEqual([]);
  });

  test("an edited or rejected new contact is a correction example like any proposal", async () => {
    const r = await run(
      Effect.gen(function* () {
        const svc = yield* Proposals;
        const [a, b] = yield* thread({ ...sarah, team: null }, payments);
        yield* svc.approve(a ?? "", {
          kind: "create_person",
          ref: "$person:1",
          displayName: "Sarah Lee",
          title: "Principal engineer",
          email: null,
          jiraUsername: null,
          team: null,
          responsibilities: null,
          profile: { formality: "formal" },
          note: "Owns the signing certificates",
        });
        yield* svc.reject(b ?? "");
        return yield* query((d) =>
          d
            .select({ subjectId: memories.subjectId, content: memories.content })
            .from(memories)
            .all(),
        );
      }),
    );
    expect(r).toEqual([
      {
        subjectId: "create_person",
        content:
          "Changed: Add contact Sarah Lee, Staff engineer -> Add contact Sarah Lee, Principal engineer",
      },
      { subjectId: "create_team", content: "Rejected: Add team Payments" },
    ]);
  });

  test("a contact or team that exists by approval is used instead, by what needs it too", async () => {
    const r = await run(
      Effect.gen(function* () {
        const svc = yield* Proposals;
        const [team, person, wait] = yield* thread(payments, sarah, waitOnSarah);
        const existing = yield* createPerson({ displayName: "sarah  lee" });
        const teamId = newId();
        yield* query((d) => d.insert(teams).values({ id: teamId, name: "PAYMENTS" }));
        const results = yield* svc.approveAll((yield* row(team ?? "")).inboxItemId ?? "");
        const dep = yield* query((d) =>
          d.select().from(dependencies).where(eq(dependencies.label, "Signed certificate")).get(),
        );
        return {
          existing,
          teamId,
          results,
          person: (yield* row(person ?? "")).result,
          plan: yield* svc.revokePlan(person ?? ""),
          owner: dep?.ownerPersonId,
          waitStatus: (yield* row(wait ?? "")).status,
          people: (yield* listPeople).length,
        };
      }),
    );
    expect(r.results.map((x) => [x.status, x.message])).toEqual([
      ["executed", "PAYMENTS was already a team; using it instead"],
      ["executed", "sarah  lee was already a contact; using them instead"],
      ["executed", "PAY-2 now waits on Signed certificate"],
    ]);
    expect(r.person).toMatchObject({ personId: r.existing, existingId: r.existing });
    expect(r.owner).toBe(r.existing);
    expect(r.people).toBe(1);
    // Nothing was added, so nothing is deleted by a revoke.
    expect(r.plan.impossible).toContain("Nothing was added");
  });

  test("revoking a move whose earlier team was deleted since leaves the contact without a team", async () => {
    const r = await run(
      Effect.gen(function* () {
        const svc = yield* Proposals;
        const old = newId();
        const next = newId();
        yield* query((d) =>
          d.insert(teams).values([
            { id: old, name: "Old" },
            { id: next, name: "Next" },
          ]),
        );
        const zed = yield* createPerson({ displayName: "Zed", teamId: old });
        const [move] = yield* thread({
          kind: "update_person",
          personId: zed,
          changes: { team: next },
        });
        yield* svc.approve(move ?? "");
        yield* query((d) => d.delete(teams).where(eq(teams.id, old)));
        const plan = yield* svc.revokePlan(move ?? "");
        const revoked = yield* svc.revoke(move ?? "");
        return {
          plan: plan.entries.flatMap((e) => [...e.steps.map((s) => s.text), ...e.warnings]),
          revoked,
          team: (yield* listPeople).find((p) => p.id === zed)?.teamId,
        };
      }),
    );
    expect(r.plan).toEqual([
      "Put back the team of Zed",
      "The team Zed was in before was deleted, so Zed has no team.",
    ]);
    expect(r.revoked.status).toBe("revoked");
    expect(r.team).toBeNull();
  });

  test("rejecting a new team drops what needs it, and what needs that in turn", async () => {
    const r = await run(
      Effect.gen(function* () {
        const svc = yield* Proposals;
        const ids = yield* thread(payments, sarah, waitOnSarah, {
          kind: "remember",
          memoryKind: "fact",
          content: "Unrelated",
        });
        yield* svc.reject(ids[0] ?? "");
        const rows = [];
        for (const id of ids) rows.push(yield* row(id));
        return rows.map((x) => [x.status, (x.result as { reason?: string } | null)?.reason]);
      }),
    );
    expect(r).toEqual([
      ["rejected", undefined],
      ["rejected", "The contact or team it needs was rejected."],
      ["rejected", "The contact or team it needs was rejected."],
      ["pending", undefined],
    ]);
  });

  test("two approvals at once add one contact; the other uses it", async () => {
    const r = await run(
      Effect.gen(function* () {
        const svc = yield* Proposals;
        const [a] = yield* thread({ ...sarah, team: null });
        const [b] = yield* thread({ ...sarah, team: null });
        const both = yield* Effect.all([svc.approve(a ?? ""), svc.approve(b ?? "")], {
          concurrency: 2,
        });
        return { both, people: (yield* listPeople).map((p) => p.displayName) };
      }),
    );
    expect(r.both.map((x) => x.status)).toEqual(["executed", "executed"]);
    expect(r.both.map((x) => x.message).sort()).toEqual([
      "Added Sarah Lee to your contacts",
      "Sarah Lee was already a contact; using them instead",
    ]);
    expect(r.people).toEqual(["Sarah Lee"]);
  });

  test("a contact moves to a new team, and revoking the team moves them back", async () => {
    const r = await run(
      Effect.gen(function* () {
        const svc = yield* Proposals;
        const old = newId();
        yield* query((d) => d.insert(teams).values({ id: old, name: "Network" }));
        const tom = yield* createPerson({ displayName: "Tom Kay", teamId: old });
        const [team, move] = yield* thread(payments, {
          kind: "update_person",
          personId: tom,
          changes: { team: "$team:1" },
        });
        yield* svc.approve(team ?? "");
        yield* svc.approve(move ?? "");
        const moved = (yield* listPeople).find((p) => p.id === tom)?.teamId;
        const plan = yield* svc.revokePlan(team ?? "");
        const revoked = yield* svc.revoke(team ?? "");
        return {
          old,
          moved,
          plan: plan.entries.flatMap((e) => e.steps.map((s) => s.text)),
          revoked,
          after: (yield* listPeople).find((p) => p.id === tom)?.teamId,
          teams: (yield* listTeams).map((t) => t.name),
          statuses: [(yield* row(team ?? "")).status, (yield* row(move ?? "")).status],
        };
      }),
    );
    expect(r.moved).not.toBe(r.old);
    expect(r.plan).toEqual(["Put back the team of Tom Kay", "Delete the team Payments"]);
    expect(r.revoked.status).toBe("revoked");
    expect(r.after).toBe(r.old);
    expect(r.teams).toEqual(["Network"]);
    expect(r.statuses).toEqual(["revoked", "revoked"]);
  });

  test("revoking a contact undoes what the thread did with them first, newest first", async () => {
    const r = await run(
      Effect.gen(function* () {
        const svc = yield* Proposals;
        const [person, wait, draft, pending] = yield* thread(
          { ...sarah, team: null },
          waitOnSarah,
          draftToSarah,
          { ...draftToSarah, notes: "Thank her" },
        );
        for (const id of [person, wait, draft]) yield* svc.approve(id ?? "");
        const personId = ((yield* row(person ?? "")).result as { personId?: string }).personId;
        const plan = yield* svc.revokePlan(person ?? "");
        const revoked = yield* svc.revoke(person ?? "");
        return {
          plan: plan.entries.flatMap((e) => e.steps.map((s) => s.text)),
          revoked,
          person: yield* query((d) =>
            d
              .select()
              .from(people)
              .where(eq(people.id, personId ?? ""))
              .get(),
          ),
          waits: yield* query((d) => d.select().from(dependencies).all()),
          drafts: yield* query((d) => d.select().from(communications).all()),
          pending: yield* row(pending ?? ""),
        };
      }),
    );
    expect(r.plan).toEqual([
      "Delete the draft",
      "Delete the wait on Signed certificate",
      "Delete the contact Sarah Lee",
    ]);
    expect(r.revoked.status).toBe("revoked");
    expect(r.person).toBeUndefined();
    expect(r.waits.filter((w) => w.label === "Signed certificate")).toEqual([]);
    expect(r.drafts).toEqual([]);
    // What still waited for her can never run.
    expect(r.pending.status).toBe("rejected");
    expect(r.pending.result).toMatchObject({
      reason: "The contact or team it needs was revoked.",
    });
  });

  test("a contact edited since, or used outside the thread, stays and the revoke says why", async () => {
    const r = await run(
      Effect.gen(function* () {
        const svc = yield* Proposals;
        const [a] = yield* thread({ ...sarah, team: null });
        const [b] = yield* thread({
          ...sarah,
          ref: "$person:1",
          displayName: "Omar Haddad",
          team: null,
        });
        yield* svc.approve(a ?? "");
        yield* svc.approve(b ?? "");
        const idOf = (id: string) =>
          Effect.map(row(id), (x) => (x.result as { personId?: string }).personId ?? "");
        const sarahId = yield* idOf(a ?? "");
        const omarId = yield* idOf(b ?? "");
        yield* query((d) =>
          d.update(people).set({ title: "Principal engineer" }).where(eq(people.id, sarahId)),
        );
        yield* query((d) =>
          d.insert(contextNotes).values({
            id: newId(),
            subjectType: "person",
            subjectId: omarId,
            title: "Org chart",
            bodyMd: "x",
            importedAt: nowIso(),
          }),
        );
        const plans = [yield* svc.revokePlan(a ?? ""), yield* svc.revokePlan(b ?? "")];
        const refused = yield* Effect.either(svc.revoke(b ?? ""));
        return {
          impossible: plans.map((p) => p.impossible),
          refused: refused._tag,
          still: (yield* listPeople).map((p) => p.displayName),
        };
      }),
    );
    expect(r.impossible).toEqual([
      "Sarah Lee was edited since they were added (title), so they stay. Change it back, or delete them on the Context page.",
      "Omar Haddad is still used by a context note, so they stay.",
    ]);
    expect(r.refused).toBe("Left");
    expect(r.still).toEqual(["Omar Haddad", "Sarah Lee"]);
  });

  test("the delete checks again when it runs: a wait added after the plan keeps the contact", async () => {
    const r = await run(
      Effect.gen(function* () {
        const svc = yield* Proposals;
        const [a] = yield* thread({ ...sarah, team: null });
        yield* svc.approve(a ?? "");
        const result = (yield* row(a ?? "")).result as {
          personId: string;
          undo: { created: Record<string, unknown> };
        };
        yield* query((d) =>
          d.insert(dependencies).values({
            id: newId(),
            issueKey: "PAY-2",
            kind: "person",
            label: "Late wait",
            ownerPersonId: result.personId,
            status: "open",
            requestedAt: nowIso(),
          }),
        );
        const executor = yield* Executor;
        return yield* Effect.either(
          executor.reverse(
            { kind: "delete_person", personId: result.personId, created: result.undo.created },
            { proposalId: a ?? "" },
          ),
        );
      }),
    );
    expect(r._tag).toBe("Left");
    expect(r._tag === "Left" && r.left.message).toBe(
      "Sarah Lee is still used by a wait, so they stay.",
    );
  });
});

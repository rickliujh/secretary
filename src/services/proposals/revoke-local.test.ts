/** Revoking the local kinds (D54): waits, contacts, teams, memories and drafts. */
import { describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { communications, inboxItems, memories, people, proposals, teams } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { type Db, query } from "@/services/db";
import { createDependency, getDependency } from "@/services/dependencies/queries";
import { createPerson, createTeam } from "@/services/directory/queries";
import { ExecutorLive } from "@/services/executor/live";
import { inboxDetail } from "@/services/inbox/queries";
import { syncedJiraLayer, syncOnce } from "@/test/seed";
import { type ProposalError, Proposals, type StoredProposalPayload } from ".";
import { ProposalsLive } from "./live";

const layer = () =>
  Layer.provideMerge(ProposalsLive, Layer.provideMerge(ExecutorLive, syncedJiraLayer().layer));

const add = (payload: StoredProposalPayload) =>
  Effect.gen(function* () {
    const id = newId();
    yield* query((d) =>
      d.insert(proposals).values({
        id,
        seq: 0,
        kind: payload.kind,
        payload,
        status: "pending",
        createdAt: nowIso(),
      }),
    );
    return id;
  });

const run = <A>(program: Effect.Effect<A, unknown, Proposals | Db>) =>
  Effect.runPromise(
    Effect.provide(
      Effect.flatMap(syncOnce, () => program),
      layer(),
    ) as Effect.Effect<A, unknown, never>,
  );

const statusOf = (id: string) =>
  Effect.map(
    query((d) =>
      d.select({ status: proposals.status }).from(proposals).where(eq(proposals.id, id)).get(),
    ),
    (r) => r?.status,
  );

describe("revoking local kinds", () => {
  test("link_dependency deletes the wait; update_dependency restores it and drops its entry", async () => {
    const r = await run(
      Effect.gen(function* () {
        const svc = yield* Proposals;
        const link = yield* add({
          kind: "link_dependency",
          target: "PAY-2",
          dependencyKind: "external",
          label: "Vendor quote",
        });
        yield* svc.approve(link);
        const made = yield* query((d) =>
          d.select().from(proposals).where(eq(proposals.id, link)).get(),
        );
        const depId = (made?.result as { dependencyId?: string } | undefined)?.dependencyId ?? "";
        const other = yield* createDependency({
          issueKey: "PAY-2",
          kind: "team",
          label: "Finance export",
          expectedAt: "2026-09-30",
        });
        const update = yield* add({
          kind: "update_dependency",
          dependencyId: other,
          action: "resolve",
          summary: "Export arrived",
          channel: "email",
        });
        yield* svc.approve(update);
        const resolved = yield* getDependency(other);
        const revokedUpdate = yield* svc.revoke(update);
        const restored = yield* getDependency(other);
        const revokedLink = yield* svc.revoke(link);
        return {
          resolved,
          revokedUpdate,
          restored,
          revokedLink,
          wait: yield* getDependency(depId),
          statuses: [yield* statusOf(update), yield* statusOf(link)],
        };
      }),
    );
    expect(r.resolved?.dependency.status).toBe("resolved");
    expect(r.resolved?.timeline.map((t) => t.summary)).toEqual(["Export arrived"]);
    expect(r.revokedUpdate.status).toBe("revoked");
    expect(r.restored?.dependency).toMatchObject({
      status: "open",
      expectedAt: "2026-09-30",
      resolvedAt: null,
    });
    expect(r.restored?.timeline).toEqual([]);
    expect(r.revokedLink.undone).toEqual(["Deleted the wait on Vendor quote"]);
    expect(r.wait).toBeNull();
    expect(r.statuses).toEqual(["revoked", "revoked"]);
  });

  test("a wait update retried after a failed run keeps the state the first run found", async () => {
    const r = await run(
      Effect.gen(function* () {
        const svc = yield* Proposals;
        const wait = yield* createDependency({
          issueKey: "PAY-2",
          kind: "team",
          label: "Finance export",
          expectedAt: "2026-10-30",
        });
        const update = yield* add({
          kind: "update_dependency",
          dependencyId: wait,
          action: "reschedule",
          expectedAt: "2026-10-30",
        });
        // A first run that failed after it had already rescheduled the wait: it
        // kept the state it found (expected 2026-09-30) on the failed result.
        const found = {
          status: "open" as const,
          expectedAt: "2026-09-30",
          nextFollowupAt: null,
          resolvedAt: null,
          notifiedOn: null,
        };
        yield* query((d) =>
          d
            .update(proposals)
            .set({
              status: "failed",
              result: {
                error: "Database busy",
                undo: {
                  kind: "update_dependency",
                  dependencyId: wait,
                  before: found,
                  after: null,
                  followupId: null,
                },
              },
            })
            .where(eq(proposals.id, update)),
        );
        const retried = yield* svc.approve(update);
        const row = yield* query((d) =>
          d.select().from(proposals).where(eq(proposals.id, update)).get(),
        );
        const revoked = yield* svc.revoke(update);
        return { retried, row, revoked, restored: yield* getDependency(wait) };
      }),
    );
    expect(r.retried.status).toBe("executed");
    expect((r.row?.result as { undo?: unknown } | null)?.undo).toMatchObject({
      before: { expectedAt: "2026-09-30" },
    });
    expect(r.revoked.status).toBe("revoked");
    expect(r.restored?.dependency.expectedAt).toBe("2026-09-30");
  });

  test("update_person and update_team put back the columns they changed", async () => {
    const r = await run(
      Effect.gen(function* () {
        const svc = yield* Proposals;
        const dana = yield* createPerson({ displayName: "Dana", title: "Analyst" });
        const finance = yield* createTeam({ name: "Finance" });
        const p = yield* add({
          kind: "update_person",
          personId: dana,
          changes: { title: "Finance lead", awayUntil: "2026-10-20" },
          noteAppend: "Prefers email",
        });
        const t = yield* add({
          kind: "update_team",
          teamId: finance,
          changes: { channel: "#finance" },
        });
        yield* svc.approve(p);
        yield* svc.approve(t);
        // The user changes the away date by hand afterwards; that stays.
        yield* query((d) =>
          d.update(people).set({ awayUntil: "2026-10-25" }).where(eq(people.id, dana)),
        );
        const plan = yield* svc.revokePlan(p);
        const person = yield* svc.revoke(p);
        const team = yield* svc.revoke(t);
        return {
          plan,
          person,
          team,
          dana: yield* query((d) => d.select().from(people).where(eq(people.id, dana)).get()),
          finance: yield* query((d) => d.select().from(teams).where(eq(teams.id, finance)).get()),
        };
      }),
    );
    expect(r.plan.entries[0]?.steps.map((s) => s.text)).toEqual([
      "Put back the title and notes of Dana",
    ]);
    expect(r.person.warning).toBe(
      "The away until of Dana was changed since, so it stays as it is.",
    );
    expect(r.dana).toMatchObject({ title: "Analyst", notesMd: null, awayUntil: "2026-10-25" });
    expect(r.team.undone).toEqual(["Put back the channel of Finance"]);
    expect(r.finance?.channel).toBeNull();
  });

  test("remember forgets; a draft is deleted, but a sent one cannot be revoked", async () => {
    const r = await run(
      Effect.gen(function* () {
        const svc = yield* Proposals;
        const m = yield* add({
          kind: "remember",
          memoryKind: "fact",
          content: "Dana is in Lisbon",
        });
        const d1 = yield* add({ kind: "draft_message", channel: "teams", intent: "fyi" });
        const d2 = yield* add({ kind: "draft_message", channel: "email", intent: "chase" });
        for (const id of [m, d1, d2]) yield* svc.approve(id);
        const sentId =
          (
            (yield* query((d) => d.select().from(proposals).where(eq(proposals.id, d2)).get()))
              ?.result as { communicationId?: string } | undefined
          )?.communicationId ?? "";
        yield* query((d) =>
          d.update(communications).set({ status: "sent" }).where(eq(communications.id, sentId)),
        );
        yield* svc.revoke(m);
        yield* svc.revoke(d1);
        const sentPlan = yield* svc.revokePlan(d2);
        const refused = yield* Effect.flip(svc.revoke(d2));
        // The thread view says so on the card, before the confirmation opens (FR-14.5).
        const thread = newId();
        yield* query((d) =>
          d.insert(inboxItems).values({
            id: thread,
            source: "teams",
            rawText: "x",
            receivedAt: nowIso(),
            status: "filed",
          }),
        );
        yield* query((d) =>
          d
            .update(proposals)
            .set({ inboxItemId: thread })
            .where(inArray(proposals.id, [d1, d2])),
        );
        const view = yield* inboxDetail(thread);
        return {
          cards: view?.proposals.map((p) => [p.id === d2, p.revokeBlocked]),
          memories: yield* query((d) =>
            d.select().from(memories).where(eq(memories.kind, "fact")).all(),
          ),
          drafts: yield* query((d) => d.select().from(communications).all()),
          sentPlan,
          refused: refused as ProposalError,
          statuses: [yield* statusOf(m), yield* statusOf(d1), yield* statusOf(d2)],
        };
      }),
    );
    expect(r.memories).toEqual([]);
    expect(r.drafts.map((d) => d.status)).toEqual(["sent"]);
    expect(r.sentPlan.impossible).toContain("already sent");
    expect(r.refused.message).toContain("already sent");
    expect(r.statuses).toEqual(["revoked", "revoked", "executed"]);
    expect(r.cards).toEqual([
      [false, null],
      [true, "The draft was already sent; a message that went out cannot be taken back."],
    ]);
  });

  test("nothing runs when the steps changed since the user confirmed them", async () => {
    const r = await run(
      Effect.gen(function* () {
        const svc = yield* Proposals;
        const m = yield* add({ kind: "remember", memoryKind: "fact", content: "x" });
        yield* svc.approve(m);
        const refused = yield* Effect.flip(svc.revoke(m, ["Delete PAY-1 in Jira"]));
        const again = yield* Effect.flip(
          svc.revoke(m, ["Forget the memory"]).pipe(Effect.andThen(svc.revoke(m))),
        );
        return {
          refused: refused as ProposalError,
          again: again as ProposalError,
          status: yield* statusOf(m),
        };
      }),
    );
    expect(r.refused.message).toContain("changed since you opened it");
    // Revoked once; a second revoke says so.
    expect(r.again.message).toBe("It is already revoked.");
    expect(r.status).toBe("revoked");
  });
});

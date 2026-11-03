/**
 * `Proposals.approveBundle` (Phase 25): an outcome card's steps run in `seq`
 * order; a failed required step stops the rest; steps left out are rejected
 * and recorded as corrections on the work item; leaving out a required step
 * leaves out what hangs on it; a card with no steps is filed; dismissing
 * rejects every step without corrections and counts toward the quiet list.
 */
import { describe, expect, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import {
  communications,
  dependencies,
  followups,
  inboxItems,
  memories,
  proposals,
  workEvents,
  workItems,
} from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { query } from "@/services/db";
import { ExecutorLive } from "@/services/executor/live";
import { quietOfItem } from "@/services/work/outcomes";
import type { SituationRecord } from "@/services/work/schema";
import { fixtureIssues, syncedJiraLayer, syncOnce } from "@/test/seed";
import { json, noContent, type StubRoute } from "@/test/stub-fetch";
import { type ProposalPayload, Proposals } from ".";
import { ProposalsLive } from "./live";

const transitions = {
  transitions: [
    { id: "11", name: "Reopen", to: { name: "To Do", statusCategory: { key: "new" } } },
    { id: "31", name: "Resolve", to: { name: "Done", statusCategory: { key: "done" } } },
  ],
};

function setup() {
  const routes: StubRoute[] = [
    {
      // Fresh reads of a fixture issue, such as the status a move leaves (D54).
      match: (u, r) => /\/issue\/[A-Z]+-\d+$/.test(u.pathname) && r.method === "GET",
      respond: (r) => {
        const issue = fixtureIssues.find((i) => r.url.pathname.endsWith(`/issue/${i.key}`));
        return issue ? json(issue) : json({ errorMessages: ["Issue Does Not Exist"] }, 404);
      },
    },
    {
      match: (u, r) => u.pathname.endsWith("/transitions") && r.method === "GET",
      respond: () => json(transitions),
    },
    {
      match: (u, r) => u.pathname.endsWith("/transitions") && r.method === "POST",
      respond: () => noContent(),
    },
    {
      match: (u, r) => u.pathname.endsWith("/comment") && r.method === "POST",
      respond: () =>
        json(
          {
            id: "1",
            body: "x",
            created: "2026-09-24T10:00:00.000+0100",
            updated: "2026-09-24T10:00:00.000+0100",
          },
          201,
        ),
    },
  ];
  const jira = syncedJiraLayer(routes);
  const layer = Layer.provideMerge(ProposalsLive, Layer.provideMerge(ExecutorLive, jira.layer));
  return { layer, seen: jira.seen };
}

const step = {
  move: (toStatus: string): ProposalPayload => ({
    kind: "transition_issue",
    target: "PAY-4",
    toStatus,
  }),
  comment: {
    kind: "add_comment",
    target: "PAY-4",
    bodyMd: "PLAT-812 is done; picking this up again.",
  } as ProposalPayload,
  draft: {
    kind: "draft_message",
    channel: "teams",
    intent: "status_update",
    recipientPersonId: null,
    recipientTeamId: null,
    issueKeys: ["PAY-4"],
    notes: "Tell them",
  } as ProposalPayload,
};

/** An outcome card with these steps; the first is the one the others hang on when `required`. */
const seedCard = (payloads: ProposalPayload[], required = true) =>
  Effect.gen(function* () {
    const id = newId();
    yield* query((d) =>
      d
        .insert(workItems)
        .values({ id: "w1", name: "The cert", createdAt: nowIso() })
        .onConflictDoNothing(),
    );
    const situation: SituationRecord = {
      rule: "blocker_closed",
      key: `blocker_closed:w1:${id}`,
      title: "PLAT-812 is done: pick up PAY-4",
      why: "PLAT-812 moved to Done; PAY-4 is Blocked.",
      keys: ["PAY-4"],
      waits: [],
      comments: [],
      facts: {},
      itemName: "The cert",
      steps: payloads.map((p, seq) => ({
        seq,
        label: `Step ${seq} ${p.kind}`,
        required: required && seq === 0,
      })),
    };
    yield* query((d) =>
      d.insert(inboxItems).values({
        id,
        source: "secretary",
        rawText: situation.title,
        receivedAt: nowIso(),
        status: "triaged",
        summary: situation.title,
        triage: { situation },
        workItemId: "w1",
        situationKey: situation.key,
      }),
    );
    const ids = payloads.map(() => newId());
    if (payloads.length)
      yield* query((d) =>
        d.insert(proposals).values(
          payloads.map((payload, seq) => ({
            id: ids[seq] ?? "",
            inboxItemId: id,
            seq,
            kind: payload.kind,
            payload,
            rationale: `Step ${seq}`,
            status: "pending" as const,
            createdAt: nowIso(),
            bundleId: id,
            bundleKind: "blocker_closed",
          })),
        ),
      );
    return { id, ids };
  });

const stepsOf = (id: string) =>
  query((d) =>
    d.select().from(proposals).where(eq(proposals.bundleId, id)).orderBy(asc(proposals.seq)).all(),
  );
const cardOf = (id: string) =>
  query((d) => d.select().from(inboxItems).where(eq(inboxItems.id, id)).get());
const examples = query((d) => d.select().from(memories).where(eq(memories.kind, "example")).all());

const writes = (seen: { url: string; method: string }[]) =>
  seen
    .filter((r) => r.method === "POST" && /\/(transitions|comment)$/.test(new URL(r.url).pathname))
    .map((r) => new URL(r.url).pathname.split("/").at(-1));

describe("approveBundle", () => {
  test("runs the kept steps in order; a step left out is a correction on the work item", async () => {
    const { layer, seen } = setup();
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const { id, ids } = yield* seedCard([step.move("To Do"), step.comment, step.draft]);
          const results = yield* (yield* Proposals).approveBundle(id, [ids[0] ?? "", ids[1] ?? ""]);
          return {
            results,
            steps: yield* stepsOf(id),
            card: yield* cardOf(id),
            examples: yield* examples,
          };
        }),
        layer,
      ),
    );
    expect(r.results.map((x) => x.status)).toEqual(["executed", "executed"]);
    expect(r.steps.map((p) => p.status)).toEqual(["executed", "executed", "rejected"]);
    expect(writes(seen)).toEqual(["transitions", "comment"]);
    expect(r.card?.status).toBe("filed");
    expect(r.examples).toHaveLength(1);
    expect(r.examples[0]).toMatchObject({
      subjectType: "work_item",
      subjectId: "w1",
      exampleAfter: { type: "step_left_out", rule: "blocker_closed", kind: "draft_message" },
      exampleBefore: step.draft,
    });
  });

  test("a failed required step stops the rest, which stay to retry", async () => {
    const { layer, seen } = setup();
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const { id, ids } = yield* seedCard([step.move("Blocked"), step.comment]);
          const results = yield* (yield* Proposals).approveBundle(id, ids);
          return { results, steps: yield* stepsOf(id), card: yield* cardOf(id) };
        }),
        layer,
      ),
    );
    expect(r.results.map((x) => x.status)).toEqual(["failed"]);
    expect(r.steps.map((p) => p.status)).toEqual(["failed", "pending"]);
    expect(writes(seen)).toEqual([]);
    expect(r.card?.status).toBe("triaged");
  });

  test("leaving out the required step leaves out what hangs on it", async () => {
    const { layer, seen } = setup();
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const { id, ids } = yield* seedCard([step.move("To Do"), step.comment]);
          const results = yield* (yield* Proposals).approveBundle(id, [ids[1] ?? ""]);
          return { results, steps: yield* stepsOf(id), examples: yield* examples };
        }),
        layer,
      ),
    );
    expect(r.results).toEqual([]);
    expect(r.steps.map((p) => p.status)).toEqual(["rejected", "rejected"]);
    expect(writes(seen)).toEqual([]);
    expect(r.examples.map((m) => (m.exampleAfter as { kind: string }).kind)).toEqual([
      "transition_issue",
      "add_comment",
    ]);
  });

  test("an edit of a step runs as edited and teaches classify nothing; no steps: filed", async () => {
    const { layer } = setup();
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const svc = yield* Proposals;
          const { id, ids } = yield* seedCard([step.comment], false);
          const edited = { ...step.comment, bodyMd: "Back on it." } as ProposalPayload;
          yield* svc.saveEdit(ids[0] ?? "", edited);
          yield* svc.approveBundle(id, ids);
          const empty = yield* seedCard([]);
          const none = yield* svc.approveBundle(empty.id, []);
          return {
            steps: yield* stepsOf(id),
            examples: yield* examples,
            none,
            emptyCard: yield* cardOf(empty.id),
          };
        }),
        layer,
      ),
    );
    expect(r.steps[0]?.status).toBe("executed");
    expect(r.steps[0]?.editedPayload).toMatchObject({ bodyMd: "Back on it." });
    expect(r.examples).toEqual([]);
    expect(r.none).toEqual([]);
    expect(r.emptyCard?.status).toBe("filed");
  });

  test("dismiss rejects every step without corrections and counts toward quiet", async () => {
    const { layer, seen } = setup();
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const svc = yield* Proposals;
          const a = yield* seedCard([step.move("To Do"), step.comment]);
          yield* svc.dismiss(a.id);
          // A second dismiss of the same card is not a second rejection.
          yield* svc.dismiss(a.id);
          const once = yield* quietOfItem("w1");
          const b = yield* seedCard([step.comment], false);
          yield* svc.dismiss(b.id);
          const refused = yield* Effect.flip(svc.approveBundle(b.id, []));
          return {
            steps: yield* stepsOf(a.id),
            card: yield* cardOf(a.id),
            examples: yield* examples,
            once: [...once],
            twice: [...(yield* quietOfItem("w1"))],
            dismissed: yield* query((d) =>
              d
                .select()
                .from(workEvents)
                .where(
                  and(eq(workEvents.kind, "outcome_dismissed"), eq(workEvents.workItemId, "w1")),
                )
                .all(),
            ),
            refused,
          };
        }),
        layer,
      ),
    );
    expect(r.steps.map((p) => p.status)).toEqual(["rejected", "rejected"]);
    expect(r.card?.status).toBe("dismissed");
    expect(r.examples).toEqual([]);
    expect(writes(seen)).toEqual([]);
    expect(r.once).toEqual([]);
    expect(r.twice).toEqual(["blocker_closed"]);
    expect(r.dismissed).toHaveLength(2);
    expect(r.refused).toMatchObject({ _tag: "ProposalError", kind: "decided" });
  });
});

describe("approveBundle, review fixes", () => {
  const go = <A, R>(program: (svc: Proposals["Type"]) => Effect.Effect<A, unknown, R>) => {
    const { layer, seen } = setup();
    const run = Effect.gen(function* () {
      yield* syncOnce;
      return yield* program(yield* Proposals);
    }) as unknown as Effect.Effect<A, unknown, never>;
    return Effect.runPromise(Effect.provide(run, layer)).then((r) => ({ r, seen }));
  };

  test("a failed required step left out takes its dependents with it", async () => {
    const { r, seen } = await go((svc) =>
      Effect.gen(function* () {
        const { id, ids } = yield* seedCard([step.move("Blocked"), step.comment]);
        yield* svc.approveBundle(id, ids);
        // The move failed; the user keeps only the comment.
        yield* svc.approveBundle(id, [ids[1] ?? ""]);
        return { steps: yield* stepsOf(id), card: yield* cardOf(id) };
      }),
    );
    expect(r.steps.map((p) => p.status)).toEqual(["rejected", "rejected"]);
    expect(writes(seen)).toEqual([]);
    expect(r.card?.status).toBe("filed");
  });

  test("a failed optional step keeps the card open to retry; Done anyway files it", async () => {
    const { r } = await go((svc) =>
      Effect.gen(function* () {
        const { id, ids } = yield* seedCard([step.comment, step.move("Blocked")], false);
        yield* svc.approveBundle(id, ids);
        const open = yield* cardOf(id);
        yield* svc.fileBundle(id);
        return { open, steps: yield* stepsOf(id), card: yield* cardOf(id) };
      }),
    );
    expect(r.open?.status).toBe("triaged");
    expect(r.steps.map((p) => p.status)).toEqual(["executed", "failed"]);
    expect(r.card?.status).toBe("filed");
  });

  test("Approve all on a card runs it as its bundle, in order", async () => {
    const { r, seen } = await go((svc) =>
      Effect.gen(function* () {
        const { id } = yield* seedCard([step.move("To Do"), step.comment]);
        const results = yield* svc.approveAll(id);
        return { results, steps: yield* stepsOf(id) };
      }),
    );
    expect(r.results.map((x) => x.status)).toEqual(["executed", "executed"]);
    expect(writes(seen)).toEqual(["transitions", "comment"]);
  });

  test("an executed step revokes like any approval", async () => {
    const { r } = await go((svc) =>
      Effect.gen(function* () {
        const { id, ids } = yield* seedCard([step.draft], false);
        yield* svc.approveBundle(id, ids);
        const drafted = (yield* stepsOf(id))[0]?.result as { communicationId?: string } | null;
        const revoked = yield* svc.revoke(ids[0] ?? "");
        const draft = yield* query((d) =>
          d
            .select()
            .from(communications)
            .where(eq(communications.id, drafted?.communicationId ?? ""))
            .get(),
        );
        return { drafted, revoked, steps: yield* stepsOf(id), draft };
      }),
    );
    expect(r.drafted?.communicationId).toBeDefined();
    expect(r.revoked.status).toBe("revoked");
    expect(r.steps[0]?.status).toBe("revoked");
    expect(r.draft).toBeUndefined();
  });

  test("dismissing a card that already ran a step does not count toward quiet", async () => {
    const { r } = await go(() =>
      Effect.gen(function* () {
        const svc = yield* Proposals;
        for (let i = 0; i < 2; i++) {
          const { id, ids } = yield* seedCard([step.comment, step.draft], false);
          yield* svc.approveBundle(id, [ids[0] ?? ""]);
          yield* svc.dismiss(id);
        }
        return [...(yield* quietOfItem("w1"))];
      }),
    );
    expect(r).toEqual([]);
  });

  test("a chase draft keeps its wait, so marking it sent logs the follow-up", async () => {
    const { r } = await go((svc) =>
      Effect.gen(function* () {
        yield* query((d) =>
          d.insert(dependencies).values({
            id: "w-chase",
            issueKey: "PAY-4",
            kind: "external",
            label: "the vendor's answer",
            status: "waiting",
            requestedAt: nowIso(),
          }),
        );
        const chase = {
          ...step.draft,
          intent: "chase",
          dependencyId: "w-chase",
        } as ProposalPayload;
        const plan = {
          kind: "update_dependency",
          dependencyId: "w-chase",
          action: "reschedule",
          summary: "Follow-up planned for 2026-10-23",
          logged: false,
          expectedAt: null,
          nextFollowupAt: "2026-10-23",
          channel: "teams",
          issueKey: "PAY-4",
          label: "the vendor's answer",
        } as ProposalPayload;
        const { id, ids } = yield* seedCard([chase, plan]);
        yield* svc.approveBundle(id, ids);
        const drafted = (yield* stepsOf(id))[0]?.result as { communicationId?: string } | null;
        const draft = yield* query((d) =>
          d
            .select()
            .from(communications)
            .where(eq(communications.id, drafted?.communicationId ?? ""))
            .get(),
        );
        return {
          draft,
          wait: yield* query((d) =>
            d.select().from(dependencies).where(eq(dependencies.id, "w-chase")).get(),
          ),
          logged: yield* query((d) =>
            d.select().from(followups).where(eq(followups.dependencyId, "w-chase")).all(),
          ),
        };
      }),
    );
    expect(r.draft?.dependencyId).toBe("w-chase");
    // Planning the next follow-up logs no chase: only sending the draft does.
    expect(r.wait?.nextFollowupAt).toBe("2026-10-23");
    expect(r.logged).toEqual([]);
  });
});

/**
 * Waits from intake (FR-3.6, FR-3.7, D46, D47) over the fixtures and a scripted
 * model: "Bob sent the numbers" from Bob proposes resolving Bob's wait, and one
 * click resolves it through the Waiting page's functions, mirror included; an
 * out-of-office reply sets the away date, which puts the wait to sleep.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { dependencies, memories, people } from "@/db/schema";
import type { ItemSnapshot } from "@/prompts/classify";
import { query } from "@/services/db";
import { timing } from "@/services/dependencies/logic";
import { dueForReminder, getDependency, listDependencies } from "@/services/dependencies/queries";
import { ExecutorLive } from "@/services/executor/live";
import { Proposals } from "@/services/proposals";
import { ProposalsLive } from "@/services/proposals/live";
import { promptOf, readThread, TODAY } from "@/test/helpers";
import { intakeTestLayer, out } from "@/test/intake-layer";
import { syncOnce } from "@/test/seed";
import { json } from "@/test/stub-fetch";
import { Intake } from ".";

const WAIT_ID = "01JWAIT0B0B000000000000000";
/** A fixed id, so a scripted answer can name him. */
const BOB = "p-bob";
const remoteLinks = {
  match: (u: URL, r: { method: string }) =>
    u.pathname.endsWith("/remotelink") && r.method === "POST",
  respond: () => json({ id: 10001, self: "x" }, 201),
};
const e = {
  rationale: "Bob sent what we waited for",
  evidence: "sent the numbers",
  confidence: 0.9,
};

function layerWith(answers: unknown[]) {
  const intake = intakeTestLayer({ "std-m": answers.map(out) }, [remoteLinks]);
  return {
    layer: Layer.provideMerge(ProposalsLive, Layer.provideMerge(ExecutorLive, intake.layer)),
    models: intake.models,
    seen: intake.seen,
  };
}

/** Bob, and a mirrored wait on him for PAY-2, opened before today. */
const seedBob = Effect.gen(function* () {
  yield* syncOnce;
  const bob = BOB;
  yield* query((d) =>
    d.insert(people).values({ id: bob, displayName: "Bob Ray", email: "bob@example.com" }),
  );
  yield* query((d) =>
    d.insert(dependencies).values({
      id: WAIT_ID,
      issueKey: "PAY-2",
      kind: "person",
      label: "Q3 numbers from finance",
      ownerPersonId: bob,
      status: "waiting",
      requestedAt: "2026-09-18T09:00:00.000Z",
      expectedAt: "2026-09-22",
      nextFollowupAt: "2026-09-23",
      mirrorRemoteLinkId: "10001",
    }),
  );
  return bob;
});

describe("intake and waits (FR-3 AC)", () => {
  test("'Bob sent the numbers' from Bob proposes resolving Bob's wait; one click resolves it", async () => {
    const { layer, models, seen } = layerWith([
      {
        summary: "Bob sent the Q3 numbers",
        question: null,
        confidence: 0.9,
        proposals: [
          {
            kind: "update_dependency",
            dependencyId: WAIT_ID,
            waitAction: "resolve",
            reply: "Bob sent the numbers",
            ...e,
          },
        ],
      },
    ]);
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const bob = yield* seedBob;
          const triaged = yield* (yield* Intake).triage({
            text: "Bob sent the numbers",
            source: "teams",
            senderPersonId: bob,
            today: TODAY,
          });
          const thread = yield* readThread(triaged.inboxItemId);
          const proposal = thread.props[0];
          if (!proposal) throw new Error("no proposal");
          const decided = yield* (yield* Proposals).approve(proposal.id);
          const after = yield* getDependency(WAIT_ID);
          return { thread, decided, after };
        }),
        layer,
      ),
    );
    const snap = r.thread.items[0]?.snapshot as ItemSnapshot;
    expect(snap.waits?.map((w) => [w.id, w.reasons])).toEqual([
      [WAIT_ID, ["sender", "named", "ticket", "wording"]],
    ]);
    expect(promptOf(models.calls, 0)).toContain(
      `- ${WAIT_ID}: PAY-2 waits on Q3 numbers from finance`,
    );
    expect(r.thread.props.map((p) => p.payload)).toEqual([
      {
        kind: "update_dependency",
        dependencyId: WAIT_ID,
        action: "resolve",
        summary: "Bob sent the numbers",
        expectedAt: null,
        nextFollowupAt: null,
        channel: "teams",
        issueKey: "PAY-2",
        label: "Q3 numbers from finance",
        logged: true,
      },
      // The wait_resolved playbook (Phase 26): it says so on the ticket.
      {
        kind: "add_comment",
        target: "PAY-2",
        bodyMd: "No longer waiting on Bob Ray for Q3 numbers from finance: it is done.",
      },
    ]);
    expect(r.decided).toMatchObject({
      status: "executed",
      message: "Resolved: PAY-2 waits on Q3 numbers from finance",
    });
    expect(r.after?.dependency).toMatchObject({ status: "resolved", nextFollowupAt: null });
    expect(r.after?.dependency.resolvedAt).not.toBeNull();
    expect(r.after?.timeline.map((t) => [t.channel, t.summary])).toEqual([
      ["teams", "Bob sent the numbers"],
    ]);
    // The mirrored remote link now says resolved.
    const posts = seen.filter((x) => x.url.endsWith("/remotelink") && x.method === "POST");
    expect(posts.at(-1)?.body).toMatchObject({ object: { status: { resolved: true } } });
  });

  test("an out-of-office reply sets the away date; the wait sleeps, then Bob is back", async () => {
    // TODAY is Thursday 2026-09-24; "back on Monday the 28th" means away until Friday the 25th.
    const { layer, models } = layerWith([
      {
        summary: "Bob is out until Monday",
        question: null,
        confidence: 0.9,
        proposals: [{ kind: "update_person", personId: BOB, awayUntil: "2026-09-25", ...e }],
      },
    ]);
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* seedBob;
          const triaged = yield* (yield* Intake).triage({
            text: "Automatic reply: I am out of the office and back on Monday 28 September.",
            source: "email",
            senderPersonId: BOB,
            today: TODAY,
          });
          const thread = yield* readThread(triaged.inboxItemId);
          const proposal = thread.props[0];
          if (!proposal) throw new Error("no proposal");
          const decided = yield* (yield* Proposals).approve(proposal.id);
          const bob = yield* query((d) => d.select().from(people).where(eq(people.id, BOB)).get());
          const rows = yield* listDependencies();
          return {
            thread,
            decided,
            bob,
            rows,
            remindFri: yield* dueForReminder("2026-09-25"),
            remindMon: yield* dueForReminder("2026-09-28"),
          };
        }),
        layer,
      ),
    );
    expect(promptOf(models.calls, 0)).toContain("out-of-office or leave notice");
    expect(r.thread.props[0]?.payload).toEqual({
      kind: "update_person",
      personId: BOB,
      changes: { awayUntil: "2026-09-25" },
      noteAppend: null,
    });
    expect(r.decided.status).toBe("executed");
    expect(r.bob?.awayUntil).toBe("2026-09-25");
    const [row] = r.rows;
    if (!row) throw new Error("no wait");
    expect(timing(row, "2026-09-25")).toMatchObject({ asleep: true, followupDue: false });
    expect(r.remindFri).toEqual([]);
    expect(timing(row, "2026-09-28")).toMatchObject({
      backSince: "2026-09-28",
      reason: "Bob Ray is back",
    });
    expect(r.remindMon.map((x) => x.reason)).toEqual(["Bob Ray is back"]);
  });
});

describe("a wait's playbook in a thread (Phase 26)", () => {
  const contract = {
    kind: "link_dependency",
    target: "PAY-2",
    dependencyKind: "person",
    label: "the signed contract",
    ownerPersonId: BOB,
    ...e,
  };
  const answer = (expectedAt: string | null) => ({
    summary: "Waiting on Bob for the signed contract",
    question: null,
    confidence: 0.9,
    proposals: [{ ...contract, expectedAt }],
  });

  test("a reply revises the wait only; the playbook expands it again", async () => {
    const { layer, models } = layerWith([answer(null), answer("2026-09-30")]);
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* seedBob;
          const intake = yield* Intake;
          const t = yield* intake.triage({
            text: "I'm waiting on Bob for the signed contract for PAY-2",
            source: "typed",
            senderPersonId: null,
            today: TODAY,
          });
          const first = (yield* readThread(t.inboxItemId)).props;
          yield* intake.reply({
            inboxItemId: t.inboxItemId,
            instruction: "He said by 30 September",
            today: TODAY,
          });
          return { first, after: (yield* readThread(t.inboxItemId)).props };
        }),
        layer,
      ),
    );
    expect(r.first.map((p) => p.kind)).toEqual(["link_dependency", "add_comment", "draft_message"]);
    // The model is shown the wait it proposed, not the chores code added.
    const revision = promptOf(models.calls, 1);
    expect(revision).toContain("the signed contract");
    expect(revision).not.toContain("Waiting on Bob Ray for");
    expect(r.after.filter((p) => p.status === "superseded").map((p) => p.kind)).toEqual([
      "link_dependency",
      "add_comment",
      "draft_message",
    ]);
    const live = r.after.filter((p) => p.status === "pending");
    expect(live.map((p) => p.kind)).toEqual(["link_dependency", "add_comment", "draft_message"]);
    expect(live[0]?.id).toBe(live[0]?.bundleId ?? "");
    expect(live[1]?.payload).toMatchObject({
      bodyMd: "Waiting on Bob Ray for the signed contract, expected 30 Sept.",
    });
  });
});

describe("a bundled wait still teaches classify (Phase 26, D46)", () => {
  const contract = {
    kind: "link_dependency",
    target: "PAY-2",
    dependencyKind: "person",
    label: "the signed contract",
    ownerPersonId: BOB,
    expectedAt: null,
    ...e,
  };
  const answer = (proposals: Record<string, unknown>[]) => ({
    summary: "Waiting on Bob for the signed contract",
    question: null,
    confidence: 0.9,
    proposals,
  });
  const triage = Effect.gen(function* () {
    yield* seedBob;
    const t = yield* (yield* Intake).triage({
      text: "I'm waiting on Bob for the signed contract for PAY-2",
      source: "typed",
      senderPersonId: null,
      today: TODAY,
    });
    return { t, props: (yield* readThread(t.inboxItemId)).props };
  });
  const examples = query((d) =>
    d.select().from(memories).where(eq(memories.kind, "example")).all(),
  );

  test("rejecting the wait rejects its card: one classify correction, as the model made it", async () => {
    const { layer } = layerWith([answer([contract])]);
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const { t, props } = yield* triage;
          const origin = props.find((p) => p.id === p.bundleId);
          yield* (yield* Proposals).reject(origin?.id ?? "");
          return {
            props: (yield* readThread(t.inboxItemId)).props,
            examples: yield* examples,
            item: (yield* readThread(t.inboxItemId)).item,
          };
        }),
        layer,
      ),
    );
    expect(r.props.map((p) => [p.kind, p.status])).toEqual([
      ["link_dependency", "rejected"],
      ["add_comment", "rejected"],
      ["draft_message", "rejected"],
    ]);
    expect(r.examples).toHaveLength(1);
    expect(r.examples[0]).toMatchObject({
      subjectType: "proposal_kind",
      subjectId: "link_dependency",
      exampleAfter: null,
    });
    // As the model made it: no follow-up date or mirror the playbook set.
    expect(r.examples[0]?.exampleBefore).toMatchObject({ nextFollowupAt: null, mirror: false });
    expect(r.item?.status).toBe("filed");
  });

  test("approving an edited wait records the edit against the wait as the model made it", async () => {
    const { layer } = layerWith([answer([contract])]);
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const { props } = yield* triage;
          const origin = props.find((p) => p.id === p.bundleId);
          const edited = { ...(origin?.payload as object), label: "the countersigned contract" };
          yield* (yield* Proposals).approve(origin?.id ?? "", edited as never);
          return yield* examples;
        }),
        layer,
      ),
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.exampleBefore).toMatchObject({
      label: "the signed contract",
      nextFollowupAt: null,
      mirror: false,
    });
    expect(r[0]?.exampleAfter).toMatchObject({
      label: "the countersigned contract",
      nextFollowupAt: null,
      mirror: false,
    });
  });

  test("a comment the user dropped in a revision is not put back by the playbook", async () => {
    const comment = { kind: "add_comment", target: "PAY-2", body: "Waiting on Bob.", ...e };
    const { layer } = layerWith([answer([contract, comment]), answer([contract])]);
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const { t, props } = yield* triage;
          yield* (yield* Intake).reply({
            inboxItemId: t.inboxItemId,
            instruction: "just track it, no comment",
            today: TODAY,
          });
          return { first: props, after: (yield* readThread(t.inboxItemId)).props };
        }),
        layer,
      ),
    );
    // The model's own comment stands in for the playbook's in the first turn.
    expect(r.first.map((p) => p.kind)).toEqual(["link_dependency", "draft_message", "add_comment"]);
    const live = r.after.filter((p) => p.status === "pending");
    expect(live.map((p) => p.kind)).toEqual(["link_dependency", "draft_message"]);
  });
});

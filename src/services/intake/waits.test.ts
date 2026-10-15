/**
 * Waits from intake (FR-3.6, FR-3.7, D46, D47) over the fixtures and a scripted
 * model: "Bob sent the numbers" from Bob proposes resolving Bob's wait, and one
 * click resolves it through the Waiting page's functions, mirror included; an
 * out-of-office reply sets the away date, which puts the wait to sleep.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { dependencies, people } from "@/db/schema";
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

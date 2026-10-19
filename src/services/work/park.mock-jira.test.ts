/**
 * FR-19.8 acceptance (Phase 27) over real HTTP against scripts/mock-jira.ts:
 * real Sync, Intake, Retrieval, Executor and Proposals; only the model is
 * scripted, and nothing in this phase asks it anything.
 *
 * - With PAY-12's item current, a paste about OPS-7 shows the Park button.
 * - Parking it keeps its proposal pending and undecided.
 * - A paste about PAY-12 is "about what you're on" and sorts first.
 * - PAY-12 done in Jira closes its item at the next pass, which brings the
 *   OPS-7 thread back to the top with its reason.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { inboxItems, proposals, workEvents, workItemIssues, workItems } from "@/db/schema";
import { query } from "@/services/db";
import { ExecutorLive } from "@/services/executor/live";
import { listInbox } from "@/services/inbox/queries";
import { Intake } from "@/services/intake";
import { IntakeLive } from "@/services/intake/live";
import { LlmLive } from "@/services/llm/live";
import { makeScriptedModels } from "@/services/llm/test";
import { ProposalsLive } from "@/services/proposals/live";
import { RetrievalLive } from "@/services/retrieval/live";
import { Sync } from "@/services/sync";
import { SyncLive } from "@/services/sync/live";
import { testProvider } from "@/test/helpers";
import { out } from "@/test/intake-layer";
import { jiraSettings, jiraTestLayer } from "@/test/layers";
import { createHandler, generate } from "../../../scripts/mock-jira";
import { currentWork } from "./next-query";
import { parkThread, threadAbout } from "./park";
import { runWorkPass } from "./pass";
import { setCurrent } from "./queries";

const servers: { stop: (force?: boolean) => void }[] = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

const jiraNow = () => new Date().toISOString().replace("Z", "+0000");
const OPS_PASTE = "OPS-7: can you rotate the staging credentials today?";
const PAY_PASTE = "PAY-12: Dana asks when the cert lands";

const stateOut = (goal: string, currentStep: string) => ({
  goal,
  currentStep,
  nextExpectedWhat: null,
  nextExpectedOn: null,
  commitments: [],
  openQuestions: [],
  people: [],
  question: null,
  choices: [],
});

function setup() {
  const issues = generate(40);
  const all = [...issues.values()];
  const me = all.find((i) => i.assignee?.name === "me")?.assignee;
  const ana = all.find((i) => i.assignee?.name === "ana.b")?.assignee;
  if (!me || !ana) throw new Error("fixture: users");
  // Only the tickets of this test are the user's.
  for (const i of all) if (i.assignee?.name === "me") i.assignee = ana;
  const pay = issues.get("PAY-12");
  if (!pay) throw new Error("fixture: PAY-12");
  Object.assign(pay, {
    type: "Story",
    summary: "Renew the payment gateway cert",
    status: "In Progress",
    assignee: me,
    epic: null,
    parent: null,
    links: [],
    updated: jiraNow(),
  });
  issues.set("OPS-7", {
    ...(issues.get("OPS-7") ?? pay),
    id: issues.get("OPS-7")?.id ?? "29998",
    key: "OPS-7",
    project: "OPS",
    type: "Task",
    summary: "Rotate the database credentials",
    status: "In Progress",
    assignee: me,
    epic: null,
    parent: null,
    links: [],
    comments: [],
    updated: jiraNow(),
  });
  const server = Bun.serve({ port: 0, fetch: createHandler(issues) });
  servers.push(server);
  const base = jiraTestLayer((input, init) => fetch(input, init), {
    ...jiraSettings({ baseUrl: `http://localhost:${server.port}`, trackedEpics: [] }),
    providers: [testProvider],
    tiers: {
      fast: { providerId: "p1", model: "fast-m" },
      standard: { providerId: "p1", model: "std-m" },
      strong: null,
    },
  });
  const models = makeScriptedModels({
    "std-m": [
      // The OPS-7 paste: a comment to approve.
      out({
        summary: "Rotate the staging credentials today",
        question: null,
        confidence: 0.9,
        proposals: [
          {
            kind: "add_comment",
            target: "OPS-7",
            body: "On it after the cert.",
            rationale: "Asked to rotate",
            evidence: "rotate the staging credentials",
            confidence: 0.9,
          },
        ],
      }),
      // The PAY-12 paste: a comment on the ticket the user is on.
      out({
        summary: "Dana asks about the cert",
        question: null,
        confidence: 0.9,
        proposals: [
          {
            kind: "add_comment",
            target: "PAY-12",
            body: "The cert lands Friday.",
            rationale: "Dana asked",
            evidence: "Dana asks when the cert lands",
            confidence: 0.9,
          },
        ],
      }),
      // The pass folds both messages in, the current item first.
      out(stateOut("Renew the payment cert", "Waiting for the cert")),
      out(stateOut("Rotate the database credentials", "Asked to rotate staging")),
    ],
  });
  const llm = Layer.provideMerge(
    LlmLive,
    Layer.merge(Layer.provideMerge(SyncLive, base), models.layer),
  );
  const layer = Layer.provideMerge(
    Layer.merge(IntakeLive, ProposalsLive),
    Layer.provideMerge(Layer.merge(RetrievalLive, ExecutorLive), llm),
  );
  return { layer, models, issues };
}

const itemOf = (key: string) =>
  Effect.map(
    query((d) => d.select().from(workItemIssues).where(eq(workItemIssues.issueKey, key)).get()),
    (m) => m?.workItemId ?? "",
  );

describe("suggestions where the user is against the mock Jira (FR-19.8 AC, Phase 27)", () => {
  test("park a paste about other work; it comes back when the current item closes", async () => {
    const { layer, models, issues } = setup();
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sync = yield* Sync;
          const intake = yield* Intake;
          yield* sync.run();
          yield* runWorkPass();
          const cert = yield* itemOf("PAY-12");
          const ops = yield* itemOf("OPS-7");
          yield* setCurrent(cert);

          const opsTurn = yield* intake.triage({
            text: OPS_PASTE,
            source: "teams",
            senderPersonId: null,
          });
          const payTurn = yield* intake.triage({
            text: PAY_PASTE,
            source: "teams",
            senderPersonId: null,
          });
          yield* runWorkPass();
          const callsBefore = models.calls.length;
          const opsAbout = yield* threadAbout(opsTurn.inboxItemId);
          const payAbout = yield* threadAbout(payTurn.inboxItemId);
          const listed = yield* listInbox();
          const panel = yield* currentWork();

          const parked = yield* parkThread(opsTurn.inboxItemId, null);
          const opsThread = yield* query((d) =>
            d.select().from(inboxItems).where(eq(inboxItems.id, opsTurn.inboxItemId)).get(),
          );
          const opsProposals = yield* query((d) =>
            d.select().from(proposals).where(eq(proposals.inboxItemId, opsTurn.inboxItemId)).all(),
          );
          const parkedList = yield* listInbox();

          // PAY-12 is done in Jira: the next sync and pass close its item.
          const pay = issues.get("PAY-12");
          if (pay) Object.assign(pay, { status: "Done", updated: jiraNow() });
          yield* sync.run();
          const pass = yield* runWorkPass();
          const certAfter = yield* query((d) =>
            d.select().from(workItems).where(eq(workItems.id, cert)).get(),
          );
          const back = yield* query((d) =>
            d.select().from(inboxItems).where(eq(inboxItems.id, opsTurn.inboxItemId)).get(),
          );
          const backProposals = yield* query((d) =>
            d.select().from(proposals).where(eq(proposals.inboxItemId, opsTurn.inboxItemId)).all(),
          );
          const backList = yield* listInbox();
          const timeline = yield* query((d) =>
            d.select().from(workEvents).where(eq(workEvents.workItemId, ops)).all(),
          );
          return {
            cert,
            ops,
            opsTurn,
            payTurn,
            callsBefore,
            opsAbout,
            payAbout,
            listed,
            panel,
            parked,
            opsThread,
            opsProposals,
            parkedList,
            pass,
            certAfter,
            back,
            backProposals,
            backList,
            timeline,
            callsAfter: models.calls.length,
          };
        }),
        layer,
      ),
    );

    expect(r.cert).not.toBe("");
    expect(r.ops).not.toBe(r.cert);
    // The Park button: about other work, while PAY-12's item is current.
    expect(r.opsAbout).toMatchObject({
      canPark: true,
      about: { kind: "other", itemId: r.ops, current: "Renew the payment cert" },
    });
    // A paste about PAY-12 is about what you're on, and sorts first.
    expect(r.payAbout).toMatchObject({ canPark: false, about: { kind: "current" } });
    expect(r.listed[0]?.id).toBe(r.payTurn.inboxItemId);
    expect(r.listed[0]?.about?.kind).toBe("current");
    expect(r.panel).toMatchObject({ id: r.cert, name: "Renew the payment cert" });

    // Parking decides nothing.
    expect(r.parked?.reason).toBe("on Renew the payment cert");
    expect(r.opsThread?.status).toBe("parked");
    expect(r.opsProposals.map((p) => [p.kind, p.status, p.decidedAt])).toEqual([
      ["add_comment", "pending", null],
    ]);
    expect(r.parkedList.at(-1)?.id).toBe(r.opsTurn.inboxItemId);

    // Closing PAY-12's item brings it back to the top, with its reason.
    expect(r.certAfter).toMatchObject({ status: "done", current: false });
    expect(r.pass.returned).toBe(1);
    expect(r.back).toMatchObject({
      status: "triaged",
      parkedReason: "on Renew the payment cert",
      parkedUntil: null,
    });
    expect(r.backProposals.map((p) => p.status)).toEqual(["pending"]);
    expect(r.backList[0]).toMatchObject({
      id: r.opsTurn.inboxItemId,
      returned: true,
      parkedReason: "on Renew the payment cert",
    });
    const kinds = r.timeline.map((e) => e.kind);
    expect(kinds).toContain("parked");
    expect(kinds).toContain("unparked");
    expect(r.timeline.find((e) => e.kind === "unparked")?.summary).toContain(
      '"Renew the payment cert" is done',
    );
    // Parking and its return asked the model nothing.
    expect(r.callsAfter).toBe(r.callsBefore);
  });
});

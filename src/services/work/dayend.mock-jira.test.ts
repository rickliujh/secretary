/**
 * FR-19.9 acceptance (Phase 28) over real HTTP against scripts/mock-jira.ts:
 * real Sync, Intake, Retrieval, Executor and Proposals; only the model is
 * scripted, and the end-of-day pass asks it nothing.
 *
 * PAY-12 is due tomorrow; Ana commented on it today; the user waits on Dana
 * with a follow-up tomorrow; a draft to Dana has sat unsent for two days; the
 * state update asked a question the day's ration (zero here) held back. The
 * day's page lists each, releases the question with its choices, answering it
 * from the page goes through `Intake.reply`, a rerun replaces the page and
 * drops the answered question, and Done files it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { communications, inboxItems, proposals, workEvents, workItemIssues } from "@/db/schema";
import { localDate } from "@/lib/dates";
import { createDraft } from "@/services/comms/queries";
import { query } from "@/services/db";
import { createDependency } from "@/services/dependencies/queries";
import { createPerson } from "@/services/directory/queries";
import { ExecutorLive } from "@/services/executor/live";
import { inboxDetail } from "@/services/inbox/queries";
import { Intake } from "@/services/intake";
import { IntakeLive } from "@/services/intake/live";
import { LlmLive } from "@/services/llm/live";
import { makeScriptedModels } from "@/services/llm/test";
import { ProposalsLive } from "@/services/proposals/live";
import { RetrievalLive } from "@/services/retrieval/live";
import { defaultSettings } from "@/services/settings/schema";
import { Sync } from "@/services/sync";
import { SyncLive } from "@/services/sync/live";
import { testProvider } from "@/test/helpers";
import { out } from "@/test/intake-layer";
import { jiraSettings, jiraTestLayer } from "@/test/layers";
import { createHandler, generate } from "../../../scripts/mock-jira";
import { tomorrowOf } from "./dayend";
import { closeDayEnd, runDayEnd } from "./dayend-query";
import { runWorkPass } from "./pass";

const servers: { stop: (force?: boolean) => void }[] = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

const jiraNow = () => new Date().toISOString().replace("Z", "+0000");
const TOMORROW = tomorrowOf(localDate());
const QUESTION = "Does Dana need the ETA in writing?";

function setup() {
  const issues = generate(40);
  const all = [...issues.values()];
  const me = all.find((i) => i.assignee?.name === "me")?.assignee;
  const ana = all.find((i) => i.assignee?.name === "ana.b")?.assignee;
  if (!me || !ana) throw new Error("fixture: users");
  // Only PAY-12 is the user's.
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
    comments: [],
    due: TOMORROW,
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
    // No question goes out during the day: the ration holds them all back.
    work: { ...defaultSettings().work, questionsPerDay: 0 },
  });
  const models = makeScriptedModels({
    "std-m": [
      // The pass folds in today's events and has a question it cannot settle.
      out({
        goal: "Renew the payment gateway cert",
        currentStep: "Waiting on Dana for the cert files",
        nextExpectedWhat: null,
        nextExpectedOn: null,
        commitments: [],
        openQuestions: [],
        people: [],
        question: QUESTION,
        choices: ["Yes", "No"],
      }),
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
  return { layer, models, issues, ana };
}

describe("the end-of-day pass against the mock Jira (FR-19.9 AC, Phase 28)", () => {
  test("lists the day and tomorrow, releases the held question, answers, reruns, closes", async () => {
    const { layer, models, issues, ana } = setup();
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const sync = yield* Sync;
          const intake = yield* Intake;
          yield* sync.run();
          yield* runWorkPass();
          const cert =
            (yield* query((d) =>
              d.select().from(workItemIssues).where(eq(workItemIssues.issueKey, "PAY-12")).get(),
            ))?.workItemId ?? "";

          // The day: a wait on Dana due for a follow-up tomorrow, Ana's comment, an old draft.
          const dana = yield* createPerson({ displayName: "Dana Reyes" });
          yield* createDependency({
            issueKey: "PAY-12",
            kind: "person",
            label: "the cert files",
            ownerPersonId: dana,
            nextFollowupAt: TOMORROW,
          });
          const pay = issues.get("PAY-12");
          if (pay) {
            pay.comments.push({
              id: "90001",
              author: ana,
              body: "Can you share the ETA? ![x](https://example.com/p.png)",
              created: jiraNow(),
              updated: jiraNow(),
            });
            pay.updated = jiraNow();
          }
          const draft = yield* createDraft({
            kind: "teams",
            intent: "status_update",
            recipientPersonId: dana,
            issueKeys: ["PAY-12"],
            notes: "Tell Dana where the cert stands",
          });
          yield* query((d) =>
            d
              .update(communications)
              .set({ createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString() })
              .where(eq(communications.id, draft)),
          );
          yield* sync.run();
          const pass = yield* runWorkPass();
          const heldBack = yield* query((d) =>
            d.select().from(proposals).where(eq(proposals.kind, "needs_clarification")).all(),
          );
          const callsBefore = models.calls.length;

          const first = yield* runDayEnd({ trigger: "button" });
          if (first.skipped) throw new Error("skipped");
          const page = yield* inboxDetail(first.id);
          const question = page?.dayEnd?.questions[0];
          if (!question?.threadId) throw new Error("no question");
          // A choice button answers in the question's work thread.
          yield* intake.reply({
            inboxItemId: question.threadId,
            parts: [{ type: "typed", text: "Yes" }],
            answers: question.id,
          });
          const answer = yield* query((d) =>
            d.select().from(workEvents).where(eq(workEvents.kind, "answer")).all(),
          );
          const second = yield* runDayEnd({ trigger: "button" });
          if (second.skipped) throw new Error("skipped");
          const rerun = yield* inboxDetail(second.id);
          yield* closeDayEnd(second.id);
          const closed = yield* query((d) =>
            d.select().from(inboxItems).where(eq(inboxItems.id, second.id)).get(),
          );
          const pages = yield* query((d) =>
            d.select().from(inboxItems).where(eq(inboxItems.source, "secretary")).all(),
          );
          const dayEndEvents = yield* query((d) =>
            d.select().from(workEvents).where(eq(workEvents.kind, "day_end")).all(),
          );
          return {
            cert,
            pass,
            heldBack,
            first,
            page,
            question,
            answer,
            second,
            rerun,
            closed,
            pages,
            dayEndEvents,
            callsBefore,
            callsAfter: models.calls.length,
          };
        }),
        layer,
      ),
    );

    // The pass held the question back: the ration is zero.
    expect(r.pass.calls).toBe(1);
    expect(r.heldBack).toHaveLength(0);

    const md = r.page?.item.rawText ?? "";
    // What changed today, with Ana's words quoted and unable to embed an image.
    expect(md).toContain("### Renew the payment gateway cert");
    expect(md).toContain("commented on PAY\\-12: “Can you share the ETA? \\!\\[x\\]");
    expect(md).toContain("**Now:** Waiting on Dana for the cert files");
    // Tomorrow: the ticket due, the follow-up, the old draft.
    expect(md).toContain("- PAY-12 Renew the payment gateway cert, due");
    expect(md).toContain("- Follow up with Dana Reyes for the cert files on PAY-12");
    expect(md).toContain("- Status update to Dana Reyes about PAY-12, written");
    // The outcome cards the new wait and the comment raised wait for approval, by item.
    expect(md).toContain(
      "### Follow-ups waiting for your approval\n\n- Renew the payment gateway cert\n  - ",
    );
    expect(md).toContain("One question I could not settle on my own is below.");

    // The question is released with its choices and answered through Intake.reply.
    expect(r.question).toMatchObject({ question: QUESTION, choices: ["Yes", "No"] });
    expect(r.answer).toHaveLength(1);
    expect(r.answer[0]?.workItemId).toBe(r.cert);

    // A rerun replaces the page; the answered question is no longer listed.
    expect(r.second.id).toBe(r.first.id);
    expect(r.rerun?.dayEnd?.questions).toEqual([]);
    expect(r.rerun?.item.rawText).toContain("You: Question");
    expect(r.pages.filter((p) => p.situationKey?.startsWith("day_end:"))).toHaveLength(1);
    expect(r.closed?.status).toBe("filed");
    expect(r.dayEndEvents.map((e) => [e.workItemId, e.applied])).toEqual([[r.cert, true]]);

    // The end-of-day pass, the answer and the rerun asked the model nothing.
    expect(r.callsAfter).toBe(r.callsBefore);
  });
});

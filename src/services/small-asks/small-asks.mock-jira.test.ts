/**
 * FR-10 acceptance over real HTTP (Phase 11 checklist): with a home set, a
 * pasted ask from a contact yields one Track row, and one click creates the
 * ticket in the home with the label, assigned to the user, in the active
 * sprint, due when asked, naming the contact. Real Intake, Retrieval, Sync,
 * Executor and Proposals against scripts/mock-jira.ts; only the model is scripted.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { dependencies, issueMeta, jiraIssues } from "@/db/schema";
import { query } from "@/services/db";
import { createPerson } from "@/services/directory/queries";
import { ExecutorLive } from "@/services/executor/live";
import { inboxDetail } from "@/services/inbox/queries";
import { Intake } from "@/services/intake";
import { IntakeLive } from "@/services/intake/live";
import { LlmLive } from "@/services/llm/live";
import { makeScriptedModels } from "@/services/llm/test";
import { Proposals } from "@/services/proposals";
import { ProposalsLive } from "@/services/proposals/live";
import { RetrievalLive } from "@/services/retrieval/live";
import { Sync } from "@/services/sync";
import { SyncLive } from "@/services/sync/live";
import { testProvider } from "@/test/helpers";
import { out } from "@/test/intake-layer";
import { jiraSettings, jiraTestLayer } from "@/test/layers";
import { boardSprints, createHandler, generate } from "../../../scripts/mock-jira";
import { groupSmallAsks, trackOrder } from "./bundle";

const servers: { stop: (force?: boolean) => void }[] = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

const DUE = "2026-10-09";
const e = {
  rationale: "Dana asked for the numbers",
  evidence: "send me the Q3 numbers",
  confidence: 0.9,
};
const answer = {
  summary: "Dana wants the Q3 numbers by Friday",
  question: null,
  confidence: 0.9,
  proposals: [
    {
      kind: "create_issue",
      ref: "$new:1",
      smallAsk: "yes",
      summary: "Send Dana the Q3 numbers",
      description: "Totals per region.",
      dueDate: DUE,
      issueType: "",
      ...e,
    },
    {
      kind: "link_dependency",
      target: "$new:1",
      dependencyKind: "team",
      label: "Finance export of Q3 totals",
      ...e,
    },
  ],
};

function setup() {
  const issues = generate(80);
  // The user has open work in the PAY board's active sprint, so that is where asks go.
  const active = boardSprints(1).find((s) => s.state === "active");
  const mine = [...issues.values()].find(
    (i) => i.project === "PAY" && i.type === "Story" && i.status !== "Done",
  );
  if (!active || !mine) throw new Error("fixture");
  mine.assignee = { name: "me", displayName: "Me Myself", emailAddress: "me@example.com" };
  mine.movedToSprint = active.id;
  const server = Bun.serve({ port: 0, fetch: createHandler(issues) });
  servers.push(server);
  const base = jiraTestLayer((input, init) => fetch(input, init), {
    ...jiraSettings({ baseUrl: `http://localhost:${server.port}`, trackedEpics: [] }),
    providers: [testProvider],
    tiers: { fast: null, standard: { providerId: "p1", model: "std-m" }, strong: null },
    smallAsks: {
      projectKey: "PAY",
      label: "small-ask",
      joinActiveSprint: true,
      hintDismissed: false,
    },
  });
  const models = makeScriptedModels({ "std-m": [out(answer)] });
  const llm = Layer.provideMerge(
    LlmLive,
    Layer.merge(Layer.provideMerge(SyncLive, base), models.layer),
  );
  const layer = Layer.provideMerge(
    Layer.merge(IntakeLive, ProposalsLive),
    Layer.provideMerge(Layer.merge(RetrievalLive, ExecutorLive), llm),
  );
  return { issues, active, layer };
}

describe("small asks against the mock Jira (FR-10 AC)", () => {
  test("one row, one click: a ticket in the home with label, assignee, sprint, due date and requester", async () => {
    const { issues, active, layer } = setup();
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* (yield* Sync).run();
          const dana = yield* createPerson({ displayName: "Dana Reyes", title: "Finance lead" });
          const turn = yield* (yield* Intake).triage({
            text: "can you send me the Q3 numbers by Friday?",
            source: "teams",
            senderPersonId: dana,
            today: "2026-10-05",
          });
          const detail = yield* inboxDetail(turn.inboxItemId);
          const rows = groupSmallAsks(detail?.proposals ?? []);
          const row = rows[0];
          if (rows.length !== 1 || row?.type !== "track") throw new Error("expected one Track row");
          // Nothing exists in Jira before the click.
          const before = issues.size;
          const results = yield* (yield* Proposals).track(trackOrder(row.create, row.members));
          const key = results[0]?.issueKey ?? "";
          return {
            dana,
            before,
            results,
            key,
            members: row.members.length,
            cached: yield* query((d) =>
              d.select().from(jiraIssues).where(eq(jiraIssues.key, key)).get(),
            ),
            meta: yield* query((d) =>
              d.select().from(issueMeta).where(eq(issueMeta.issueKey, key)).get(),
            ),
            deps: yield* query((d) => d.select().from(dependencies).all()),
          };
        }),
        layer,
      ),
    );
    expect(r.members).toBe(1);
    expect(r.results.map((x) => x.status)).toEqual(["executed", "executed"]);
    expect(r.results[0]?.message).toBe(`Created ${r.key} in sprint ${active.name}`);
    expect(r.results[0]?.warning).toBeUndefined();
    const created = issues.get(r.key);
    expect(issues.size).toBe(r.before + 1);
    expect(created).toMatchObject({
      project: "PAY",
      type: "Task",
      summary: "Send Dana the Q3 numbers",
      labels: ["small-ask"],
      due: DUE,
      movedToSprint: active.id,
    });
    expect(created?.assignee?.name).toBe("me");
    expect(created?.description).toContain("_Asked by Dana Reyes via Teams on 2026-10-05:_");
    // The pasted words arrive literally, not as wiki markup.
    expect(created?.description).toContain(
      "{noformat}\ncan you send me the Q3 numbers by Friday?\n{noformat}",
    );
    // The cache shows Jira's version, and the contact is linked locally.
    expect(r.cached).toMatchObject({ sprint: active.name, labels: ["small-ask"], assignee: "me" });
    expect(r.meta?.requesterPersonId).toBe(r.dana);
    // What hung on the new ticket ran after it, against the created key.
    expect(r.deps.map((d) => [d.issueKey, d.label])).toEqual([
      [r.key, "Finance export of Q3 totals"],
    ]);
  });
});

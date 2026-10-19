/**
 * Standing instructions over the in-memory Db (Phase 26): the "make that the
 * rule?" offer from stored corrections and answers, and the Jira projects a
 * sync infers for contacts and teams.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { memories, people, teams } from "@/db/schema";
import { query } from "@/services/db";
import { inferJiraProjects, setJiraProjects } from "@/services/directory/projects";
import { Settings } from "@/services/settings";
import { insertIssues, issue, workTestLayer } from "@/test/work";
import { answerOffer, offerFor } from "./offers";

const leftOut = (kind: string, at: string, rule = "waiting_on_someone") =>
  query((d) =>
    d.insert(memories).values({
      id: `m-${kind}-${at}`,
      kind: "example",
      subjectType: "work_item",
      content: "Left out",
      exampleAfter: { type: "step_left_out", rule, kind },
      source: "user",
      confirmed: true,
      createdAt: at,
    }),
  );

const STEPS = ["link_dependency", "add_comment", "draft_message"];

describe('"make that the rule?" (Phase 26)', () => {
  test("Yes turns the instruction off and counts only later left-outs", async () => {
    const { run } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        yield* leftOut("add_comment", "2026-10-01T09:00:00.000Z");
        const once = yield* offerFor("waiting_on_someone", STEPS);
        yield* leftOut("add_comment", "2026-10-02T09:00:00.000Z");
        const twice = yield* offerFor("waiting_on_someone", STEPS);
        if (twice) yield* answerOffer(twice, "yes");
        const settings = yield* (yield* Settings).get;
        const after = yield* offerFor("waiting_on_someone", STEPS);
        const remembered = yield* query((d) =>
          d.select().from(memories).where(eq(memories.subjectType, "playbook")).all(),
        );
        return { once, twice, settings, after, remembered };
      }),
    );
    expect(r.once).toBeNull();
    expect(r.twice?.text).toBe("You left the comment out twice. Make that the rule?");
    expect(r.settings.secretary.instructions.commentWaits).toBe(false);
    expect(r.after).toBeNull();
    expect(r.remembered).toHaveLength(1);
    expect(r.remembered[0]).toMatchObject({
      kind: "preference",
      subjectId: "waiting_on_someone:add_comment",
      exampleAfter: { type: "instruction_offer", answer: "yes" },
    });
  });

  test("No keeps the instruction and is not offered again", async () => {
    const { run } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        yield* leftOut("draft_message", "2026-10-01T09:00:00.000Z");
        yield* leftOut("draft_message", "2026-10-02T09:00:00.000Z");
        const offer = yield* offerFor("waiting_on_someone", STEPS);
        if (offer) yield* answerOffer(offer, "no");
        yield* leftOut("draft_message", "2026-10-03T09:00:00.000Z");
        yield* leftOut("draft_message", "2026-10-04T09:00:00.000Z");
        return {
          offer,
          again: yield* offerFor("waiting_on_someone", STEPS),
          settings: yield* (yield* Settings).get,
        };
      }),
    );
    expect(r.offer?.instruction).toBe("draftRequests");
    expect(r.again).toBeNull();
    expect(r.settings.secretary.instructions.draftRequests).toBe(true);
  });
});

describe("Jira projects of contacts and teams (Phase 26)", () => {
  test("a sync infers a person's from their tickets and a team's from its members", async () => {
    const { run } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        yield* query((d) =>
          d.insert(teams).values({
            id: "t1",
            name: "Platform",
            jiraProjects: [{ key: "INFRA", by: "user" }],
          }),
        );
        yield* query((d) =>
          d.insert(people).values([
            { id: "p1", displayName: "Sarah Chen", jiraUsername: "Sarah.C", teamId: "t1" },
            { id: "p2", displayName: "No Jira" },
          ]),
        );
        yield* insertIssues([
          issue("PLAT-1", { assignee: "sarah.c" }),
          issue("OPS-2", { assignee: "sarah.c" }),
          // Out of scope (a candidate): it says nothing about where she works.
          issue("SEC-3", { assignee: "sarah.c", stale: true }),
          issue("PAY-4", { assignee: "me" }),
        ]);
        const changed = yield* inferJiraProjects;
        yield* setJiraProjects("person", "p1", ["ops", "QA"]);
        const sarah = yield* query((d) => d.select().from(people).where(eq(people.id, "p1")).get());
        const team = yield* query((d) => d.select().from(teams).where(eq(teams.id, "t1")).get());
        return { changed, sarah, team, again: yield* inferJiraProjects };
      }),
    );
    expect(r.changed).toBe(2);
    expect(r.team?.jiraProjects).toEqual([
      { key: "INFRA", by: "user" },
      { key: "OPS", by: "sync" },
      { key: "PLAT", by: "sync" },
    ]);
    // The user's keys stand beside the inferred ones, each once.
    expect(r.sarah?.jiraProjects).toEqual([
      { key: "OPS", by: "user" },
      { key: "QA", by: "user" },
      { key: "PLAT", by: "sync" },
    ]);
    // A later sync changes the team's (its members' now include QA), not hers.
    expect(r.again).toBe(1);
  });
});

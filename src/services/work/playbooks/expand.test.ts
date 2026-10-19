/**
 * "Find their ticket" against a stubbed Jira (Phase 26): one bounded search
 * in the owner's projects; results stored out of scope; a failure skips the
 * step with "Could not search <projects>".
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { jiraIssues } from "@/db/schema";
import { query } from "@/services/db";
import { ProposalPayloadSchema } from "@/services/proposals/schema";
import { groupSmallAsks } from "@/services/small-asks/bundle";
import { JIRA_BASE, jiraSettings, jiraTestLayer } from "@/test/layers";
import { fixtureIssues } from "@/test/seed";
import { json, stubFetch } from "@/test/stub-fetch";
import { expandTurn, findTheirTicket } from "./expand";

const raw = (key: string, summary: string) => {
  const base = fixtureIssues[0] as { fields: Record<string, unknown> };
  return {
    ...base,
    id: key.replace(/\D/g, ""),
    key,
    fields: { ...base.fields, summary, project: { id: "PLAT", key: "PLAT", name: "Platform" } },
  };
};

const settings = jiraSettings();

describe("findTheirTicket (Phase 26)", () => {
  test("searches the projects once, stores what it found out of scope, picks a clear match", async () => {
    const { fetch, seen } = stubFetch([
      {
        match: (u) => u.pathname.endsWith("/search"),
        respond: () =>
          json({
            startAt: 0,
            maxResults: 10,
            total: 3,
            issues: [
              raw("PLAT-812", "Renew the payments cert"),
              raw("PLAT-9", "Rotate the load balancer"),
              raw("PAY-12", "The user's own ticket"),
            ],
          }),
      },
    ]);
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const found = yield* findTheirTicket({
            projects: ["PLAT"],
            label: "the payments cert",
            target: "PAY-12",
            settings,
          });
          const stored = yield* query((d) =>
            d.select().from(jiraIssues).where(eq(jiraIssues.key, "PLAT-812")).get(),
          );
          return { found, stored };
        }),
        jiraTestLayer(fetch, settings),
      ),
    );
    const searches = seen.filter((s) => s.url.endsWith("/search"));
    expect(searches).toHaveLength(1);
    expect(searches[0]?.body).toMatchObject({
      jql: 'project in (PLAT) AND statusCategory != Done AND text ~ "payments cert" ORDER BY updated DESC',
      maxResults: 10,
    });
    expect(r.found.results.map((x) => [x.key, x.score])).toEqual([
      ["PLAT-812", 2],
      ["PLAT-9", 0],
    ]);
    expect(r.found.results[0]?.url).toBe(`${JIRA_BASE}/browse/PLAT-812`);
    expect(r.found.picked).toBe("PLAT-812");
    expect(r.stored?.stale).toBe(true);
  });

  test("a failed search is a line on the card, not a failure; no projects, no search", async () => {
    const { fetch, seen } = stubFetch([
      {
        match: (u) => u.pathname.endsWith("/search"),
        respond: () => json({ errorMessages: ["bad"] }, 400),
      },
    ]);
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.all([
          findTheirTicket({
            projects: ["PLAT", "OPS"],
            label: "the cert",
            target: "PAY-1",
            settings,
          }),
          findTheirTicket({ projects: [], label: "the cert", target: "PAY-1", settings }),
        ]),
        jiraTestLayer(fetch, settings),
      ),
    );
    expect(r[0]).toMatchObject({ error: "Could not search PLAT, OPS", results: [], picked: null });
    expect(r[1]).toMatchObject({ projects: [], error: null, results: [] });
    expect(seen.filter((s) => s.url.endsWith("/search"))).toHaveLength(1);
  });
});

describe("expandTurn (Phase 26)", () => {
  test("a wait on a ticket the thread is yet to create stays in its small ask's Track row", async () => {
    const turn = [
      {
        payload: ProposalPayloadSchema.parse({
          kind: "create_issue",
          ref: "$new:1",
          projectKey: "PAY",
          issueType: "Task",
          summary: "Export the Q3 numbers",
          smallAsk: true,
        }),
        rationale: "",
        evidence: "",
        confidence: 0.9,
        itemIndex: 0,
      },
      {
        payload: ProposalPayloadSchema.parse({
          kind: "link_dependency",
          target: "$new:1",
          dependencyKind: "team",
          label: "the numbers from finance",
          ownerTeamId: "t-finance",
        }),
        rationale: "",
        evidence: "",
        confidence: 0.9,
        itemIndex: 0,
      },
    ];
    const { fetch } = stubFetch([]);
    const r = await Effect.runPromise(
      Effect.provide(
        expandTurn(turn, { senderPersonId: null, today: "2026-10-19" }),
        jiraTestLayer(fetch, settings),
      ),
    );
    expect(r.bundles).toEqual([]);
    expect(r.proposals.map((p) => [p.payload.kind, p.bundleId])).toEqual([
      ["create_issue", null],
      ["link_dependency", null],
    ]);
    const rows = r.proposals.map((p, seq) => ({
      ...p,
      intakeItemId: "i1",
      kind: p.payload.kind,
      status: "pending",
      seq,
      editedPayload: null,
    }));
    const entries = groupSmallAsks(rows);
    expect(entries.map((x) => x.type)).toEqual(["track"]);
    expect(entries[0]?.type === "track" ? entries[0].members.length : 0).toBe(1);
  });
});

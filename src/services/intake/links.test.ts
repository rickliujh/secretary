/**
 * "Blocked by" links from intake (D45), over the fixtures and a scripted model:
 * a ticket named in the text that the cache does not hold is read once and
 * offered as a candidate, and a small ask that waits for it is one Track row.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { jiraIssues } from "@/db/schema";
import type { ItemSnapshot } from "@/prompts/classify";
import { query } from "@/services/db";
import { inboxDetail } from "@/services/inbox/queries";
import { groupSmallAsks } from "@/services/small-asks/bundle";
import { Sync } from "@/services/sync";
import { promptOf, readThread, TODAY } from "@/test/helpers";
import { intakeTestLayer, out } from "@/test/intake-layer";
import { fixtureIssues, syncOnce } from "@/test/seed";
import { json } from "@/test/stub-fetch";
import { Intake } from ".";

const base = fixtureIssues[0] as { fields: Record<string, unknown> };
/** Another team's ticket, outside the sync scope. */
const plat1 = {
  ...base,
  id: "99001",
  key: "PLAT-1",
  fields: {
    ...base.fields,
    summary: "Deploy the new ledger API",
    project: { id: "300", key: "PLAT", name: "Platform" },
    issuelinks: [],
  },
};
const routes = [
  {
    match: (u: URL) => u.pathname.endsWith("/issueLinkType"),
    respond: () =>
      json({
        issueLinkTypes: [
          { id: "10000", name: "Blocks", inward: "is blocked by", outward: "blocks" },
        ],
      }),
  },
  { match: (u: URL) => u.pathname.endsWith("/issue/PLAT-1"), respond: () => json(plat1) },
];
const home = {
  smallAsks: {
    projectKey: "OPS",
    label: "small-ask",
    joinActiveSprint: true,
    hintDismissed: false,
    defaultPoints: null,
  },
};
const e = {
  rationale: "Tell the vendor after the deploy",
  evidence: "once PLAT-1",
  confidence: 0.9,
};
const answer = {
  summary: "Tell the vendor once PLAT-1 is deployed",
  question: null,
  confidence: 0.9,
  proposals: [
    {
      kind: "create_issue",
      ref: "$new:1",
      smallAsk: "yes",
      summary: "Tell the vendor the new API is live",
      description: "",
      issueType: "",
      ...e,
    },
    { kind: "link_issues", target: "$new:1", blocker: "PLAT-1", ...e },
  ],
};
const text = "Once PLAT-1 is deployed, tell the vendor they can switch over.";

describe("intake with blocked-by links (FR-3.8)", () => {
  test("a ticket outside the cache is read once, offered, and the ask waits for it in one row", async () => {
    const { layer, models, seen } = intakeTestLayer(
      { "std-m": [out(answer), out(answer)] },
      routes,
      { settings: home },
    );
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const intake = yield* Intake;
          const first = yield* intake.triage({
            text,
            source: "typed",
            senderPersonId: null,
            today: TODAY,
          });
          // A second paste naming it again does not read it again.
          yield* intake.triage({ text, source: "typed", senderPersonId: null, today: TODAY });
          const detail = yield* inboxDetail(first.inboxItemId);
          return { ...(yield* readThread(first.inboxItemId)), detail };
        }),
        layer,
      ),
    );
    expect(seen.filter((x) => new URL(x.url).pathname.endsWith("/issue/PLAT-1"))).toHaveLength(1);
    const snap = r.items[0]?.snapshot as ItemSnapshot;
    expect(snap.blockLinkType).toBe("Blocks");
    expect(snap.candidates.find((c) => c.key === "PLAT-1")?.reasons).toContain("mentioned");
    expect(promptOf(models.calls, 0)).toContain("- PLAT-1 [");
    expect(r.props.map((p) => [p.kind, p.payload])).toEqual([
      ["create_issue", expect.objectContaining({ ref: "$new:1", smallAsk: true })],
      ["link_issues", { kind: "link_issues", target: "$new:1", blocker: "PLAT-1" }],
    ]);
    const rows = groupSmallAsks(r.detail?.proposals ?? []);
    expect(rows.map((x) => (x.type === "track" ? x.members.map((m) => m.kind) : x.type))).toEqual([
      ["link_issues"],
    ]);
  });

  test("a ticket read from pasted text is a candidate only: it does not widen the scope", async () => {
    const { layer, seen } = intakeTestLayer({ "std-m": [out(answer), out(answer)] }, routes, {
      settings: home,
    });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const intake = yield* Intake;
          const first = yield* intake.triage({
            text,
            source: "typed",
            senderPersonId: null,
            today: TODAY,
          });
          const stale = query((d) =>
            d
              .select({ stale: jiraIssues.stale })
              .from(jiraIssues)
              .where(eq(jiraIssues.key, "PLAT-1"))
              .get(),
          );
          const row = yield* stale;
          // The re-fetch after an approved write to it keeps it out of scope too.
          yield* (yield* Sync).refreshIssue("PLAT-1");
          const afterWrite = yield* stale;
          const mark = seen.length;
          yield* syncOnce;
          return { thread: yield* readThread(first.inboxItemId), row, afterWrite, mark };
        }),
        layer,
      ),
    );
    // Stored, but out of the sync scope.
    expect(r.row).toEqual({ stale: true });
    expect(r.afterWrite).toEqual({ stale: true });
    const snap = r.thread.items[0]?.snapshot as ItemSnapshot;
    // Offered by its key, but its project is not one to create in.
    expect(snap.candidates.find((c) => c.key === "PLAT-1")?.reasons).toContain("mentioned");
    expect(snap.projects.map((p) => p.key)).not.toContain("PLAT");
    // Sync does not read its project's metadata either.
    expect(seen.slice(r.mark).some((x) => x.url.includes("/project/PLAT/"))).toBe(false);
  });

  test("a key is marked read only after a definite answer: a transient failure is retried, a 404 is not", async () => {
    let failing = true;
    const flaky = [
      {
        match: (u: URL) => u.pathname.endsWith("/issue/PLAT-1"),
        respond: () => (failing ? new Response("down", { status: 503 }) : json(plat1)),
      },
      {
        match: (u: URL) => u.pathname.endsWith("/issue/PLAT-2"),
        respond: () => json({ errorMessages: ["Issue Does Not Exist"], errors: {} }, 404),
      },
      ...routes,
    ];
    const plain = { summary: "Two tickets", question: null, confidence: 0.9, proposals: [] };
    const { layer, seen } = intakeTestLayer(
      { "std-m": Array.from({ length: 6 }, () => out(plain)) },
      flaky,
    );
    const gets = (key: string) =>
      seen.filter((x) => x.method === "GET" && new URL(x.url).pathname.endsWith(`/issue/${key}`))
        .length;
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const intake = yield* Intake;
          const input = { text: "PLAT-1 and PLAT-2", source: "typed" as const };
          yield* intake.triage({ ...input, senderPersonId: null, today: TODAY });
          const first = { one: gets("PLAT-1"), two: gets("PLAT-2") };
          failing = false;
          const second = yield* intake.triage({ ...input, senderPersonId: null, today: TODAY });
          return { first, second: yield* readThread(second.inboxItemId) };
        }),
        layer,
      ),
    );
    expect(r.first.one).toBeGreaterThan(0);
    expect(r.first.two).toBe(1);
    expect(gets("PLAT-1")).toBeGreaterThan(r.first.one);
    expect(gets("PLAT-2")).toBe(1);
    const snap = r.second.items[0]?.snapshot as ItemSnapshot;
    expect(snap.candidates.map((c) => c.key)).toContain("PLAT-1");
  });
});

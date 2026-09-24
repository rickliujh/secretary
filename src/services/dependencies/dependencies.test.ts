import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { communications, dependencies } from "@/db/schema";
import { query } from "@/services/db";
import { createPerson, createTeam } from "@/services/directory/queries";
import type { ExecutorError } from "@/services/executor";
import { ExecutorLive } from "@/services/executor/live";
import { syncedJiraLayer, syncOnce } from "@/test/seed";
import { json, noContent } from "@/test/stub-fetch";
import { groupByOwner } from "./logic";
import {
  createDependency,
  dueForReminder,
  getDependency,
  listDependencies,
  logFollowup,
  markNotified,
  mirror,
  requestChaseDraft,
  setStatus,
} from "./queries";

function setup() {
  const jira = syncedJiraLayer([
    {
      match: (u, r) => u.pathname.endsWith("/remotelink") && r.method === "POST",
      respond: () => json({ id: 10001, self: "x" }, 201),
    },
    {
      match: (u, r) => u.pathname.endsWith("/remotelink") && r.method === "DELETE",
      respond: () => noContent(),
    },
  ]);
  return { layer: Layer.provideMerge(ExecutorLive, jira.layer), seen: jira.seen };
}

const incident = (ownerTeamId: string | null) => ({
  issueKey: "PAY-2",
  kind: "incident" as const,
  label: "Platform fix",
  ownerTeamId,
  externalRef: "INC0012345",
  externalUrl: "https://snow.example.com/INC0012345",
  expectedAt: "2026-09-24",
});

describe("dependencies", () => {
  test("list joins issue and owner; an item expected yesterday is one day overdue", async () => {
    const { layer } = setup();
    const rows = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const team = yield* createTeam({ name: "Platform" });
          yield* createDependency(incident(team));
          yield* createDependency({ issueKey: "OPS-7", kind: "external", label: "Vendor quote" });
          return yield* listDependencies();
        }),
        layer,
      ),
    );
    const groups = groupByOwner(rows, "2026-09-25");
    expect(groups[0]?.owner).toMatchObject({ type: "team", name: "Platform" });
    expect(groups[0]?.items[0]).toMatchObject({
      issueSummary: "Export invoices to the new ledger",
      status: "open",
      timing: { overdueDays: 1 },
    });
    expect(groups[1]?.owner.name).toBe("No owner");
  });

  test("an incident without its number is rejected", async () => {
    const { layer } = setup();
    const exit = await Effect.runPromiseExit(
      Effect.provide(createDependency({ issueKey: "PAY-2", kind: "incident", label: "x" }), layer),
    );
    expect(exit._tag).toBe("Failure");
  });

  test("logging a follow-up records the timeline and schedules the next one in working days", async () => {
    const { layer } = setup();
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const id = yield* createDependency(incident(null));
          // 2026-09-25 is a Friday; three working days later is Wednesday.
          yield* logFollowup(id, { channel: "teams", summary: "Pinged Platform" }, "2026-09-25");
          return yield* getDependency(id);
        }),
        layer,
      ),
    );
    expect(r?.dependency).toMatchObject({ status: "waiting", nextFollowupAt: "2026-09-30" });
    expect(r?.timeline.map((t) => [t.channel, t.summary])).toEqual([["teams", "Pinged Platform"]]);
  });

  test("reminders fire once per day for due follow-ups", async () => {
    const { layer } = setup();
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* createDependency({ ...incident(null), nextFollowupAt: "2026-09-25" });
          yield* createDependency({
            ...incident(null),
            label: "Later",
            nextFollowupAt: "2026-10-05",
          });
          const first = yield* dueForReminder("2026-09-25");
          yield* markNotified(
            first.map((d) => d.id),
            "2026-09-25",
          );
          const again = yield* dueForReminder("2026-09-25");
          const tomorrow = yield* dueForReminder("2026-09-26");
          return { first, again, tomorrow };
        }),
        layer,
      ),
    );
    expect(r.first.map((d) => d.label)).toEqual(["Platform fix"]);
    expect(r.again).toEqual([]);
    expect(r.tomorrow.map((d) => d.label)).toEqual(["Platform fix"]);
  });

  test("mirroring creates a remote link, resolving updates it, turning it off deletes it", async () => {
    const { layer, seen } = setup();
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const team = yield* createTeam({ name: "Platform" });
          const id = yield* createDependency(incident(team));
          yield* mirror(id, true);
          const mirrored = yield* query((d) =>
            d.select().from(dependencies).where(eq(dependencies.id, id)).get(),
          );
          yield* setStatus(id, "resolved");
          yield* mirror(id, false);
          const after = yield* query((d) =>
            d.select().from(dependencies).where(eq(dependencies.id, id)).get(),
          );
          return { id, mirrored, after };
        }),
        layer,
      ),
    );
    const posts = seen.filter(
      (s) => s.url.endsWith("/issue/PAY-2/remotelink") && s.method === "POST",
    );
    expect(posts).toHaveLength(2);
    expect(posts[0]?.body).toMatchObject({
      globalId: `secretary:dependency:${r.id}`,
      object: {
        url: "https://snow.example.com/INC0012345",
        title: "Waiting on Platform fix (INC0012345)",
        summary: "Owner: Platform · Expected 2026-09-24 · Status: open",
        status: { resolved: false },
      },
    });
    expect(posts[1]?.body).toMatchObject({ object: { status: { resolved: true } } });
    expect(r.mirrored?.mirrorRemoteLinkId).toBe("10001");
    expect(seen.find((s) => s.method === "DELETE")?.url).toContain(
      `globalId=secretary%3Adependency%3A${r.id}`,
    );
    expect(r.after?.mirrorRemoteLinkId).toBeNull();
  });

  test("mirroring needs a link Jira can show", async () => {
    const { layer } = setup();
    const exit = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const id = yield* createDependency({
            issueKey: "PAY-2",
            kind: "external",
            label: "Vendor",
          });
          return yield* Effect.either(mirror(id, true));
        }),
        layer,
      ),
    );
    expect(exit._tag === "Left" && (exit.left as ExecutorError).kind).toBe("unsupported");
  });

  test("a chase draft request names the incident, the ask and the first request date", async () => {
    const { layer } = setup();
    const row = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          const ana = yield* createPerson({
            displayName: "Ana",
            profile: { preferredChannel: "email" },
          });
          const id = yield* createDependency({ ...incident(null), ownerPersonId: ana });
          const commId = yield* requestChaseDraft(id);
          return yield* query((d) =>
            d.select().from(communications).where(eq(communications.id, commId)).get(),
          );
        }),
        layer,
      ),
    );
    expect(row).toMatchObject({
      kind: "email",
      intent: "chase",
      status: "draft",
      issueKeys: ["PAY-2"],
    });
    expect(row?.bodyMd).toMatch(
      /^Chase Platform fix \(INC0012345\) for PAY-2\. First requested on \d{4}-\d{2}-\d{2}\. Was expected by 2026-09-24\.$/,
    );
  });
});

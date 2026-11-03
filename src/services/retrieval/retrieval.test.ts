import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { memories, proposals } from "@/db/schema";
import { query } from "@/services/db";
import { addNote } from "@/services/directory/notes";
import { createPerson, createTeam } from "@/services/directory/queries";
import { extractReferences } from "@/services/intake/preprocess";
import { markViewed } from "@/services/tickets/queries";
import { syncedJiraLayer, syncOnce } from "@/test/seed";
import { Retrieval } from ".";
import { RetrievalLive } from "./live";

describe("Retrieval.snapshot", () => {
  test("builds candidates, constraints, directory, memories and notes for an item", async () => {
    // No project metadata, so the fallback to cache-derived lists is what gets checked.
    const { layer } = syncedJiraLayer([], {}, { projectStatuses: false });
    const s = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          const platform = yield* createTeam({
            name: "Platform",
            function: "Shared infrastructure",
          });
          const ana = yield* createPerson({
            displayName: "Ana Bell",
            jiraUsername: "ana.b",
            teamId: platform,
          });
          yield* addNote(
            { type: "person", id: ana },
            { title: "Working hours", bodyMd: "Ana answers ledger questions before noon." },
          );
          yield* markViewed("PAY-4");
          yield* query((d) =>
            d.insert(memories).values([
              {
                id: "m1",
                kind: "rule",
                content: "Ledger export work goes under PAY-1.",
                source: "user",
                confirmed: true,
                createdAt: "2026-09-01T00:00:00Z",
              },
              {
                id: "m2",
                kind: "rule",
                content: "Unconfirmed guess",
                source: "inferred",
                confirmed: false,
                createdAt: "2026-09-01T00:00:00Z",
              },
              {
                id: "m3",
                kind: "example",
                content: "Rejected",
                exampleInput: "ledger export is blocked again",
                exampleBefore: { kind: "transition_issue", target: "PAY-2", toStatus: "Done" },
                exampleAfter: null,
                source: "user",
                confirmed: true,
                createdAt: "2026-09-10T00:00:00Z",
              },
            ]),
          );
          const quote = "Ana: the ledger export PAY-2 is blocked on INC0012345, can you chase?";
          const contacts = [
            { id: ana, displayName: "Ana Bell", email: null, jiraUsername: "ana.b" },
          ];
          const snap = yield* (yield* Retrieval).snapshot({
            quote,
            source: "teams",
            senderPersonId: ana,
            references: extractReferences(quote, contacts),
            today: "2026-09-24",
          });
          const usage = yield* query((d) =>
            d.select({ id: memories.id, useCount: memories.useCount }).from(memories).all(),
          );
          return { ...snap, usage };
        }),
        Layer.provideMerge(RetrievalLive, layer),
      ),
    );
    const byKey = new Map(s.candidates.map((c) => [c.key, c]));
    expect(s.candidates[0]?.key).toBe("PAY-2");
    expect(byKey.get("PAY-2")?.reasons).toContain("mentioned");
    expect(byKey.get("PAY-2")?.reasons).toContain("search");
    expect(byKey.get("OPS-7")?.reasons).toContain("search");
    expect(byKey.get("PAY-4")?.reasons).toContain("recent");
    expect(byKey.has("PAY-1")).toBe(true);
    // Without project metadata from sync, the lists come from the cache and are marked incomplete.
    expect(s.projects.find((p) => p.key === "PAY")).toMatchObject({
      issueTypes: ["Bug", "Epic", "Story", "Sub-task"],
      complete: false,
    });
    expect(s.priorities).toEqual(["Highest", "High", "Medium", "Low"]);
    expect(s.jiraUsers.map((u) => u.username)).toContain("ana.b");
    expect(s.me).toEqual({ username: "rliu" });
    expect(s.sender).toMatchObject({ displayName: "Ana Bell", team: "Platform" });
    expect(s.teams.map((t) => t.name)).toEqual(["Platform"]);
    expect(s.memories).toEqual([{ kind: "rule", content: "Ledger export work goes under PAY-1." }]);
    expect(s.examples).toEqual([
      { input: "ledger export is blocked again", proposed: "Move PAY-2 to Done", corrected: null },
    ]);
    expect(s.notes[0]).toMatchObject({ about: "Ana Bell", title: "Working hours" });
    // Memories that reached the prompt are counted as used (D26).
    expect(Object.fromEntries(s.usage.map((m) => [m.id, m.useCount]))).toEqual({
      m1: 1,
      m2: 0,
      m3: 1,
    });
  });

  test("excluded keys are never candidates, however retrieval finds them (FR-14.6)", async () => {
    const { layer } = syncedJiraLayer([]);
    const quote = "the ledger export PAY-2 is blocked, can you chase?";
    const keys = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          yield* markViewed("PAY-4");
          const retrieval = yield* Retrieval;
          const snap = (exclude?: string[]) =>
            Effect.map(
              retrieval.snapshot({
                quote,
                source: "teams",
                senderPersonId: null,
                references: extractReferences(quote, []),
                today: "2026-09-24",
                ...(exclude ? { exclude } : {}),
              }),
              (s) => s.candidates.map((c) => c.key),
            );
          return { all: yield* snap(), without: yield* snap(["PAY-2", "PAY-4"]) };
        }),
        Layer.provideMerge(RetrievalLive, layer),
      ),
    );
    expect(keys.all).toContain("PAY-2");
    expect(keys.all).toContain("PAY-4");
    expect(keys.without).not.toContain("PAY-2");
    expect(keys.without).not.toContain("PAY-4");
    expect(keys.without).toContain("OPS-7");
  });
});

describe("created candidates (prompt version 17, D66)", () => {
  test("tickets approved creates made in the last two weeks, newest first, after named and before search", async () => {
    const { layer } = syncedJiraLayer([]);
    const quote = "the ledger export PAY-2 is blocked, can you chase?";
    const made = (id: string, key: string, decidedAt: string, status = "executed") => ({
      id,
      kind: "create_issue",
      payload: { kind: "create_issue" },
      status: status as "executed",
      result: { issueKey: key },
      createdAt: decidedAt,
      decidedAt,
    });
    const s = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          yield* query((d) =>
            d.insert(proposals).values([
              made("c1", "PAY-1", "2026-09-20T10:00:00.000Z"),
              made("c2", "PAY-4", "2026-09-22T10:00:00.000Z"),
              // Older than two weeks, not approved, or not in the cache: not offered.
              made("c3", "OPS-7", "2026-09-01T10:00:00.000Z"),
              made("c4", "PAY-3", "2026-09-23T10:00:00.000Z", "rejected"),
              made("c5", "PAY-99", "2026-09-23T10:00:00.000Z"),
              // After the item's day: not offered either.
              made("c6", "PAY-3", "2026-09-26T10:00:00.000Z"),
            ]),
          );
          return yield* (yield* Retrieval).snapshot({
            quote,
            source: "teams",
            senderPersonId: null,
            references: extractReferences(quote, []),
            today: "2026-09-24",
            createdKeys: ["PAY-4"],
          });
        }),
        Layer.provideMerge(RetrievalLive, layer),
      ),
    );
    const keys = s.candidates.map((c) => c.key);
    const byKey = new Map(s.candidates.map((c) => [c.key, c]));
    // Named first, then the created ones newest first, then search.
    expect(keys.slice(0, 3)).toEqual(["PAY-2", "PAY-4", "PAY-1"]);
    expect(byKey.get("PAY-4")?.reasons[0]).toBe("created");
    expect(byKey.get("PAY-1")?.reasons[0]).toBe("created");
    expect(byKey.get("OPS-7")?.reasons).not.toContain("created");
    expect(byKey.get("PAY-3")?.reasons ?? []).not.toContain("created");
    expect(keys).not.toContain("PAY-99");
    // The thread's own creates ride along for the duplicate check, never shown.
    expect(s.createdKeys).toEqual(["PAY-4"]);
  });
});

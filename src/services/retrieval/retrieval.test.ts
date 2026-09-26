import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { memories } from "@/db/schema";
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
});

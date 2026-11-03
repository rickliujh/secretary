/**
 * Phase 24 (FR-19.5, D61 Reads): which work items an input reaches, the work
 * block retrieval builds for classify (selection, waits, candidates, budget),
 * and the times "what changed since" understands.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { workItemIssues, workItems } from "@/db/schema";
import { buildClassifyPrompt } from "@/prompts/classify";
import { renderWorkItem } from "@/prompts/work-block";
import { query } from "@/services/db";
import { createPerson } from "@/services/directory/queries";
import { extractReferences } from "@/services/intake/preprocess";
import { BUDGETS, Retrieval } from "@/services/retrieval";
import { RetrievalLive } from "@/services/retrieval/live";
import { defaultSettings } from "@/services/settings/schema";
import { EVAL_CASES } from "@/test/eval/cases";
import { seedWorkItem } from "@/test/eval/work-seed";
import { jiraSettings } from "@/test/layers";
import { syncedJiraLayer, syncOnce } from "@/test/seed";
import { insertIssues, issue } from "@/test/work";
import { pickWorkItems, resolveSince } from "./reads";

const caseNamed = (start: string) => {
  const c = EVAL_CASES.find((x) => x.name.startsWith(start));
  if (!c) throw new Error(`no eval case ${start}`);
  return c;
};
const CERT = caseNamed("work: a new date");
const PICKUP = caseNamed("work: a blocker done");
const CONTROL = caseNamed("work: with no work item");

describe("pickWorkItems", () => {
  const itemOf = (k: string) =>
    ({ "PAY-12": "cert", "PLAT-812": "cert", "PAY-4": "refund", "OPS-7": "fw", "PAY-9": "x" })[k] ??
    null;

  test("follows the signals in order, one entry per item with every reason", () => {
    expect(
      pickWorkItems(
        {
          ownKeys: ["PLAT-812"],
          threadKeys: ["PAY-4", "PAY-12"],
          senderWaitKeys: ["OPS-7"],
          contactWaitKeys: ["PAY-12"],
          currentId: null,
        },
        itemOf,
      ),
    ).toEqual([
      { id: "cert", reasons: ["named", "thread", "contact"] },
      { id: "refund", reasons: ["thread"] },
      { id: "fw", reasons: ["sender"] },
    ]);
  });

  test("at most three; the item the user is on first, never ahead of a named or thread item", () => {
    const signals = {
      ownKeys: [] as string[],
      threadKeys: [] as string[],
      senderWaitKeys: ["OPS-7"],
      contactWaitKeys: ["PAY-12"],
      currentId: null,
    };
    const isCert = (id: string) => id === "cert";
    // Reached by waits only: the current item leads.
    expect(pickWorkItems(signals, itemOf, isCert).map((p) => p.id)).toEqual(["cert", "fw"]);
    // The thread is about PAY-4: its item leads, the current item comes after.
    expect(
      pickWorkItems({ ...signals, threadKeys: ["PAY-4"] }, itemOf, isCert).map((p) => p.id),
    ).toEqual(["refund", "cert", "fw"]);
    // The current item is named too: first among the named.
    expect(
      pickWorkItems(
        { ...signals, ownKeys: ["PAY-4", "PLAT-812", "PAY-9"], contactWaitKeys: [] },
        itemOf,
        isCert,
      ).map((p) => p.id),
    ).toEqual(["cert", "refund", "x"]);
  });

  test("the current item alone when only it is offered; nothing reaches nothing", () => {
    const none = {
      ownKeys: [],
      threadKeys: [],
      senderWaitKeys: [],
      contactWaitKeys: [],
      currentId: null,
    };
    expect(pickWorkItems(none, itemOf)).toEqual([]);
    expect(pickWorkItems({ ...none, currentId: "cert" }, itemOf)).toEqual([
      { id: "cert", reasons: ["current"] },
    ]);
    // A key in no item reaches nothing.
    expect(pickWorkItems({ ...none, ownKeys: ["ZZ-1"] }, itemOf)).toEqual([]);
  });
});

describe("resolveSince", () => {
  // Thursday 24 September 2026, 15:00 local.
  const now = new Date(2026, 8, 24, 15, 0);
  const local = (y: number, m: number, d: number) => new Date(y, m, d).toISOString();

  test("reads the user's words and ISO times; anything else is null", () => {
    expect(resolveSince("this morning", now)).toBe(local(2026, 8, 24));
    expect(resolveSince("today", now)).toBe(local(2026, 8, 24));
    expect(resolveSince("Yesterday", now)).toBe(local(2026, 8, 23));
    expect(resolveSince("this week", now)).toBe(local(2026, 8, 21));
    expect(resolveSince("2026-09-20", now)).toBe(local(2026, 8, 20));
    expect(resolveSince("2026-09-22T08:30:00.000Z", now)).toBe("2026-09-22T08:30:00.000Z");
    expect(resolveSince("a while ago", now)).toBeNull();
    // Only ISO shapes: a date in words is refused, not guessed.
    expect(resolveSince("Sept 20", now)).toBeNull();
    expect(resolveSince("20/09/2026", now)).toBeNull();
  });
});

/** A synced db with the cert work item and its contacts, as the eval seeds them. */
const withCert = <A, E, R>(
  program: (ids: Record<string, string>) => Effect.Effect<A, E, R>,
  settings = {},
) => {
  const { layer } = syncedJiraLayer([], settings);
  return Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        yield* syncOnce;
        const ids: Record<string, string> = {};
        for (const [handle, p] of Object.entries(CERT.contacts ?? {}))
          ids[handle] = yield* createPerson({ displayName: p.displayName });
        if (CERT.workItem) ids.item = yield* seedWorkItem(CERT.workItem, ids);
        return yield* program(ids);
      }) as Effect.Effect<A, E, never>,
      Layer.provideMerge(RetrievalLive, layer),
    ),
  );
};

const snapshotOf = (text: string, ids: Record<string, string>, ownInput = true) =>
  Effect.gen(function* () {
    const contacts = [
      { id: ids.sarah ?? "", displayName: "Sarah Kim", email: null, jiraUsername: null },
      { id: ids.dana ?? "", displayName: "Dana Reyes", email: null, jiraUsername: null },
    ];
    const references = extractReferences(text, contacts);
    return yield* (yield* Retrieval).snapshot({
      quote: text,
      source: "typed",
      senderPersonId: null,
      references,
      ownKeys: references.issueKeys,
      ownInput,
      today: "2026-09-24",
    });
  });

describe("the work block in the retrieval snapshot (prompt version 15)", () => {
  test("a person the input names reaches the item through her open wait", async () => {
    const s = await withCert((ids) => snapshotOf(CERT.text, ids));
    expect(s.work).toHaveLength(1);
    const w = s.work?.[0];
    expect(w).toMatchObject({
      name: "Renew the payment gateway cert",
      goal: "Renew the payment gateway cert before it expires",
      reasons: ["contact"],
      keys: [
        { key: "PAY-12", status: "Blocked", role: "primary" },
        { key: "PLAT-812", status: "In Progress", role: "related" },
      ],
      commitments: [{ what: "an ETA for the cert renewal", to: "Dana Reyes", dueOn: "2026-09-25" }],
    });
    // The wait is offered both in the block and in waits, by the same id (D46).
    expect(w?.waits).toHaveLength(1);
    expect(s.waits?.map((x) => x.id)).toContain(w?.waits[0]?.id ?? "?");
    // The item's tickets are candidates the model may act on.
    const pay12 = s.candidates.find((c) => c.key === "PAY-12");
    expect(pay12?.reasons).toContain("work");
    expect(s.candidates.some((c) => c.key === "PLAT-812")).toBe(true);
    // The user's note is their own words; the seeded wait opened later is no event of the item.
    expect(w?.lastEvents.map((e) => [e.kind, e.ownWords])).toEqual([["note", true]]);
  });

  test("a ticket the item waits on, named, reaches it too", async () => {
    const s = await withCert((ids) => snapshotOf(PICKUP.text, ids));
    expect(s.work?.map((w) => w.reasons)).toEqual([["named"]]);
    expect(s.candidates.find((c) => c.key === "PAY-12")?.reasons).toContain("work");
    expect(s.candidates.find((c) => c.key === "PLAT-812")?.reasons).toContain("mentioned");
  });

  test("no item reached: the block is empty and the control case keeps its wait proposal open", async () => {
    // PAY-4 is in no item, and the input names no one with a wait.
    const s = await withCert((ids) => snapshotOf("PAY-4 needs a look at the refund rounding", ids));
    expect(s.work).toEqual([]);
    expect(buildClassifyPrompt(s).prompt).not.toContain("## The user's work");
    // The control eval case names Sarah, so it would reach the cert item: it runs without one.
    expect(CONTROL.workItem).toBeUndefined();
  });

  test("the item the user is on comes in only for their own words that name nothing", async () => {
    const r = await withCert((ids) =>
      Effect.gen(function* () {
        yield* query((d) =>
          d
            .update(workItems)
            .set({ current: true })
            .where(eq(workItems.id, ids.item ?? "")),
        );
        return {
          own: yield* snapshotOf("done with the review, moving on", ids),
          pasted: yield* snapshotOf("done with the review, moving on", ids, false),
          named: yield* snapshotOf("PAY-4 needs a look", ids),
        };
      }),
    );
    expect(r.own.work?.map((w) => [w.reasons, w.current])).toEqual([[["current"], true]]);
    expect(r.pasted.work).toEqual([]);
    expect(r.named.work).toEqual([]);
  });

  test("off in Settings > Secretary: no block", async () => {
    const s = await withCert((ids) => snapshotOf(CERT.text, ids), {
      ...jiraSettings({ trackedEpics: ["PAY-1"] }),
      work: { ...defaultSettings().work, enabled: false },
    });
    expect(s.work).toEqual([]);
    expect(s.candidates.find((c) => c.key === "PAY-12")?.reasons ?? []).not.toContain("work");
  });

  /** Three more items of eight tickets each; the input names one ticket of each. */
  const bigItems = Effect.gen(function* () {
    const long = "A very long ticket summary about the payment gateway and its renewals ".repeat(4);
    const keys: string[] = [];
    for (const n of [1, 2, 3]) {
      const id = `big-${n}`;
      yield* query((d) =>
        d.insert(workItems).values({ id, name: `Big ${n}`, createdAt: "2026-09-20T09:00:00Z" }),
      );
      const own = Array.from({ length: 8 }, (_, i) => `BIG-${n}${i}`);
      yield* insertIssues(own.map((k) => issue(k, { summary: long, assignee: "rliu" })));
      yield* query((d) =>
        d
          .insert(workItemIssues)
          .values(own.map((k) => ({ issueKey: k, workItemId: id, addedAt: "2026-09-20" }))),
      );
      keys.push(own[0] ?? "");
    }
    return keys;
  });

  test("three full items leave the search results among the candidates", async () => {
    const s = await withCert((ids) =>
      Effect.gen(function* () {
        const keys = yield* bigItems;
        return yield* snapshotOf(`What about ${keys.join(", ")} and the ledger?`, ids);
      }),
    );
    const reasons = new Map(s.candidates.map((c) => [c.key, c.reasons]));
    // Both tickets the words find are still offered.
    expect(reasons.get("PAY-2")).toContain("search");
    expect(reasons.get("OPS-7")).toContain("search");
    // At most 10 work tickets jump the queue; the others rank after the search results.
    const order = s.candidates.map((c) => c.key);
    const workBeforeSearch = order
      .slice(0, order.indexOf("OPS-7"))
      .filter((k) => reasons.get(k)?.join() === "work");
    expect(workBeforeSearch.length).toBeLessThanOrEqual(10);
  });

  test("the item the user is on stays out when the thread is about a ticket", async () => {
    const s = await withCert((ids) =>
      Effect.gen(function* () {
        yield* query((d) =>
          d
            .update(workItems)
            .set({ current: true })
            .where(eq(workItems.id, ids.item ?? "")),
        );
        // "done, thanks" in a thread about PAY-4: the thread's ticket, not the current item.
        return yield* (yield* Retrieval).snapshot({
          quote: "done, thanks",
          source: "typed",
          senderPersonId: null,
          references: { issueKeys: ["PAY-4"], tickets: [], urls: [], contactIds: [], emails: [] },
          ownKeys: [],
          ownInput: true,
          today: "2026-09-24",
        });
      }),
    );
    expect(s.work).toEqual([]);
  });

  test("the block keeps within its token budget, at least one item", async () => {
    const s = await withCert((ids) =>
      Effect.gen(function* () {
        const keys = yield* bigItems;
        return yield* snapshotOf(`What about ${keys.join(", ")}?`, ids);
      }),
    );
    const tokens = (s.work ?? []).reduce((n, w) => n + Math.ceil(renderWorkItem(w).length / 4), 0);
    expect(s.work?.length).toBeGreaterThanOrEqual(1);
    expect(s.work?.length).toBeLessThan(3);
    expect(tokens).toBeLessThanOrEqual(BUDGETS.work);
  });
});

/**
 * The chat reads the work model (Phase 24, FR-19.5, D61 Reads): work_items
 * (list, one item, what changed), note_work (a local write that asks when it
 * cannot tell the item, and requests a work pass), my_focus naming the
 * item the user is on, and day_end (Phase 28) writing the end-of-day page. Over the cert item the eval seeds.
 */
import { describe, expect, test } from "bun:test";
import type { UIMessage, UIMessageChunk } from "ai";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { workEvents, workItems } from "@/db/schema";
import { type Db, query } from "@/services/db";
import { createPerson } from "@/services/directory/queries";
import type { Scripted } from "@/services/llm/test";
import { EVAL_CASES } from "@/test/eval/cases";
import { seedWorkItem } from "@/test/eval/work-seed";
import { drainStream, promptOf } from "@/test/helpers";
import { intakeTestLayer } from "@/test/intake-layer";
import { syncOnce } from "@/test/seed";
import { Chat } from ".";

const CERT = EVAL_CASES.find((c) => c.workItem)?.workItem;

const ask = (text: string): UIMessage[] => [
  { id: "u1", role: "user", parts: [{ type: "text", text }] },
];
const outputs = (chunks: UIMessageChunk[]) =>
  chunks.flatMap((c) => (c.type === "tool-output-available" ? [c.output] : [])) as Record<
    string,
    unknown
  >[];

/** One chat turn over a synced db holding the cert item; `before` runs after seeding. */
async function turn(
  steps: Scripted[],
  question: string,
  before: (itemId: string) => Effect.Effect<unknown, unknown, Db> = () => Effect.void,
) {
  const { layer, models } = intakeTestLayer({ "std-m": steps });
  let passes = 0;
  let inboxes = 0;
  const r = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        yield* syncOnce;
        const sarah = yield* createPerson({ displayName: "Sarah Kim" });
        const dana = yield* createPerson({ displayName: "Dana Reyes" });
        if (!CERT) throw new Error("no cert case");
        const itemId = yield* seedWorkItem(CERT, { sarah, dana });
        yield* before(itemId);
        const stream = yield* (yield* Chat).stream({
          messages: ask(question),
          onWorkChanged: () => {
            passes++;
          },
          onInboxChanged: () => {
            inboxes++;
          },
        });
        const chunks = yield* Effect.promise(() => drainStream(stream));
        const items = yield* query((d) => d.select().from(workItems).all());
        const notes = yield* query((d) =>
          d.select().from(workEvents).where(eq(workEvents.kind, "note")).all(),
        );
        return { chunks, itemId, items, notes };
      }) as Effect.Effect<
        {
          chunks: UIMessageChunk[];
          itemId: string;
          items: (typeof workItems.$inferSelect)[];
          notes: (typeof workEvents.$inferSelect)[];
        },
        unknown,
        never
      >,
      layer,
    ),
  );
  return { ...r, passes, inboxes, models, out: outputs(r.chunks) };
}

const call = (name: string, input: Record<string, unknown>): Scripted => ({
  toolCall: { name, input },
});

describe("work_items (D61 Reads)", () => {
  test("list, then one item by its ticket: the state in the chat's words, no ticket search", async () => {
    const r = await turn(
      [
        call("work_items", { view: "list" }),
        call("work_items", { view: "item", item: "PLAT-812" }),
        { text: "You are waiting on Platform for the cert." },
      ],
      "where am I on the cert?",
    );
    expect(r.out[0]).toMatchObject({
      items: [
        {
          name: "Renew the payment gateway cert",
          current: false,
          goal: "Renew the payment gateway cert before it expires",
          currentStep: "Waiting on Platform (PLAT-812) to issue the new cert; Sarah is getting it",
          nextExpected: { what: "Sarah sends the new cert", on: "2026-09-23" },
          openCommitments: 1,
          tickets: ["PAY-12", "PLAT-812"],
        },
      ],
    });
    expect(r.out[1]).toMatchObject({
      name: "Renew the payment gateway cert",
      state: {
        commitments: [
          {
            what: "an ETA for the cert renewal",
            to: "Dana Reyes",
            dueOn: "2026-09-25",
            status: "open",
          },
        ],
      },
      tickets: [
        { key: "PAY-12", status: "Blocked", blockedBy: ["PLAT-812"] },
        { key: "PLAT-812", waitedOn: true },
      ],
      openWaits: [{ issueKey: "PAY-12", owner: "Sarah Kim", expectedAt: "2026-09-23" }],
    });
    const item = r.out[1] as { timeline: { kind: string; by: string }[] };
    expect(item.timeline.map((e) => [e.kind, e.by])).toEqual([["note", "the user"]]);
    // The system prompt sends these questions to work_items first.
    expect(promptOf(r.models.calls, 0)).toContain("call work_items before search_tickets");
    expect(r.passes).toBe(0);
  });

  test("an item no reference reaches, and what changed since a time", async () => {
    const r = await turn(
      [
        call("work_items", { view: "item", item: "the quarterly offsite" }),
        call("work_items", { view: "changes", since: "2026-09-01" }),
        call("work_items", { view: "changes", since: "a while back" }),
        { text: "ok" },
      ],
      "what changed since September?",
    );
    expect(r.out[0]).toMatchObject({
      error: 'No work item matches "the quarterly offsite".',
      items: ["Renew the payment gateway cert"],
    });
    expect(r.out[1]).toMatchObject({
      items: [{ item: "Renew the payment gateway cert", events: [{ kind: "note" }] }],
    });
    expect(String(r.out[2]?.error)).toContain('Cannot tell when "a while back" is');
  });
});

describe("note_work (D61, D17)", () => {
  test('"I\'m on PAY-12 now" records the note, makes the item current and asks for a pass', async () => {
    const r = await turn(
      [call("note_work", { text: "I'm on PAY-12 now", onIt: true }), { text: "Noted." }],
      "I'm on PAY-12 now",
    );
    expect(r.out[0]).toMatchObject({
      noted: true,
      item: "Renew the payment gateway cert",
      current: true,
    });
    expect(r.items.find((i) => i.id === r.itemId)?.current).toBe(true);
    const note = r.notes.find((n) => n.summary === "I'm on PAY-12 now");
    expect(note).toMatchObject({
      workItemId: r.itemId,
      actor: "me",
      attachedBy: "user",
      applied: false,
    });
    expect(r.passes).toBe(1);
  });

  test("no ticket and no item named: nothing is written and the choices come back", async () => {
    const r = await turn(
      [call("note_work", { text: "note that Dana wants it by Friday" }), { text: "Which item?" }],
      "note that Dana wants it by Friday",
    );
    // Choices carry the id, so the follow-up call can name the one the user picks.
    expect(r.out[0]).toMatchObject({
      noted: false,
      choices: [{ id: r.itemId, name: "Renew the payment gateway cert" }],
    });
    expect(String(r.out[0]?.note)).toContain("with that choice's id as item");
    expect(String(r.out[0]?.note)).toContain("Ask the user which one");
    // Only the seeded note: nothing new was recorded.
    expect(r.notes).toHaveLength(1);
    expect(r.passes).toBe(0);
  });

  test("a key in lower case reaches its item", async () => {
    const r = await turn(
      [call("note_work", { text: "i'm on pay-12 now", onIt: true }), { text: "Noted." }],
      "i'm on pay-12 now",
    );
    expect(r.out[0]).toMatchObject({ noted: true, current: true });
    expect(r.items.find((i) => i.id === r.itemId)?.current).toBe(true);
  });

  test("the item named by its name; a note does not make it current unless the user is on it", async () => {
    const r = await turn(
      [
        call("note_work", { text: "Dana wants the ETA by Friday", item: "gateway cert" }),
        { text: "Noted." },
      ],
      "note on the gateway cert that Dana wants the ETA by Friday",
    );
    expect(r.out[0]).toMatchObject({ noted: true, current: false });
    expect(r.items.find((i) => i.id === r.itemId)?.current).toBe(false);
  });
});

describe("my_focus", () => {
  test("names the item the user is on", async () => {
    const r = await turn(
      [call("my_focus", {}), { text: "The cert." }],
      "what should I focus on?",
      (itemId) =>
        query((d) => d.update(workItems).set({ current: true }).where(eq(workItems.id, itemId))),
    );
    expect(r.out[0]).toMatchObject({
      currentWork: {
        name: "Renew the payment gateway cert",
        currentStep: "Waiting on Platform (PLAT-812) to issue the new cert; Sarah is getting it",
      },
    });
  });
});

describe("day_end (D63)", () => {
  test('"wrap up my day" writes the page in the Inbox, in code, and points there', async () => {
    const r = await turn(
      [call("day_end", {}), { text: "Your day is wrapped up." }],
      "wrap up my day",
    );
    const out = r.out[0] as {
      threadId: string;
      replaced: boolean;
      counts: Record<string, number>;
      page: string;
      questions: unknown[];
      note: string;
    };
    expect(out.threadId).toBeString();
    expect(out.replaced).toBe(false);
    // Dana was promised an ETA on 25 Sep: overdue, so it is listed for tomorrow.
    expect(out.counts.promises).toBe(1);
    expect(out.page).toContain("To Dana Reyes: an ETA for the cert renewal, due overdue since");
    expect(out.page).not.toContain("\\");
    expect(out.questions).toEqual([]);
    expect(out.note).toContain("in the Inbox");
    expect(r.inboxes).toBe(1);
    expect(r.passes).toBe(0);
    expect(promptOf(r.models.calls, 0)).toContain("call day_end");
  });
});

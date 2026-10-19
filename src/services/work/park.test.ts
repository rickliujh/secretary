/**
 * Triage against the current item (FR-19.8, D62) over the in-memory Db:
 * current for the day it was set, the Inbox marks and order, parking keeps
 * proposals pending and out of Today, the pass brings a parked thread back
 * when the current item changes or closes or the day is over, and a parked
 * work thread's questions are outside the ration.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import {
  inboxItems,
  jiraIssues,
  proposals,
  workEvents,
  workItemIssues,
  workItems,
} from "@/db/schema";
import { localDate } from "@/lib/dates";
import { newId, nowIso } from "@/lib/ids";
import { loadTodayInputs } from "@/services/dashboard/data";
import { query } from "@/services/db";
import { listInbox, pendingCount, sortInbox } from "@/services/inbox/queries";
import { defaultSettings } from "@/services/settings/schema";
import { insertIssues, issue, seedSyncState, workTestLayer } from "@/test/work";
import { appendEvents } from "./events";
import {
  aboutOf,
  currentItem,
  nextLocalDay,
  parkThread,
  returnReason,
  threadAbout,
  unparkThread,
} from "./park";
import { runWorkPass } from "./pass";
import { setCurrent, workItemDetail } from "./queries";
import { askQuestions, postQuestion, workThread } from "./questions";

const itemOf = (key: string) =>
  Effect.map(
    query((d) => d.select().from(workItemIssues).where(eq(workItemIssues.issueKey, key)).get()),
    (m) => m?.workItemId ?? "",
  );
const thread = (id: string) =>
  query((d) => d.select().from(inboxItems).where(eq(inboxItems.id, id)).get());
const proposalsOf = (id: string) =>
  query((d) => d.select().from(proposals).where(eq(proposals.inboxItemId, id)).all());
const eventsOf = (kind: "parked" | "unparked") =>
  query((d) => d.select().from(workEvents).where(eq(workEvents.kind, kind)).all());

/** A pasted message whose event attached to `itemId`, with one pending proposal. */
const pasteAbout = (itemId: string, text: string) =>
  Effect.gen(function* () {
    const id = newId();
    yield* query((d) =>
      d.insert(inboxItems).values({
        id,
        source: "teams",
        rawText: text,
        receivedAt: nowIso(),
        status: "triaged",
        summary: text,
        triage: { items: 1, proposals: 1, questions: 0, at: nowIso() },
      }),
    );
    yield* query((d) =>
      d.insert(proposals).values({
        id: newId(),
        inboxItemId: id,
        kind: "add_comment",
        payload: { kind: "add_comment", target: "OPS-7", bodyMd: "Noted." },
        status: "pending",
        createdAt: nowIso(),
      }),
    );
    yield* appendEvents([
      {
        kind: "message",
        actor: "unknown",
        summary: "A message",
        data: {
          inboxItemId: id,
          intakeItemId: newId(),
          quote: text,
          instruction: null,
          keys: [],
          contactIds: [],
          senderPersonId: null,
          source: "teams",
          ownWords: false,
          byChat: false,
          revision: false,
        },
        workItemId: itemId,
        attachedBy: "code",
        applied: true,
      },
    ]);
    return id;
  });

/** PAY-12 and OPS-7, two items; PAY-12's is current. */
const twoItems = Effect.gen(function* () {
  yield* seedSyncState;
  yield* insertIssues([
    issue("PAY-12", { summary: "Renew the payment cert" }),
    issue("OPS-7", { summary: "Rotate the database credentials" }),
  ]);
  yield* runWorkPass();
  const cert = yield* itemOf("PAY-12");
  const ops = yield* itemOf("OPS-7");
  yield* setCurrent(cert);
  return { cert, ops };
});

describe("pure parts (D62)", () => {
  const current = { id: "a", name: "Cert", currentOn: "2026-10-21" };
  const names = new Map([
    ["a", "Cert"],
    ["b", "Rotate creds"],
  ]);
  test("a thread is about what you're on, about other work, or nothing", () => {
    expect(aboutOf(new Set(["a", "b"]), current, names)).toEqual({
      kind: "current",
      itemId: "a",
      name: "Cert",
    });
    expect(aboutOf(new Set(["b"]), current, names)).toEqual({
      kind: "other",
      itemId: "b",
      name: "Rotate creds",
      current: "Cert",
    });
    expect(aboutOf(new Set(["b"]), null, names)).toBeNull();
    expect(aboutOf(new Set(), current, names)).toBeNull();
  });

  test("why a parked thread comes back", () => {
    const against = { id: "a", name: "Cert", status: "active", mergedInto: null };
    const base = { parkedUntil: "2026-10-22", today: "2026-10-21", against, current };
    expect(returnReason(base)).toBeNull();
    expect(returnReason({ ...base, today: "2026-10-22" })).toBe("a new day");
    expect(returnReason({ ...base, current: null })).toBe('you are no longer on "Cert"');
    expect(returnReason({ ...base, current: null, against: { ...against, status: "done" } })).toBe(
      '"Cert" is done',
    );
    expect(returnReason({ ...base, current: { id: "c", name: "Other", currentOn: null } })).toBe(
      'you moved on to "Other"',
    );
    // Merged into the current item: the same work, it stays.
    expect(
      returnReason({
        ...base,
        current: { id: "c", name: "Other", currentOn: null },
        against: { ...against, status: "dismissed", mergedInto: "c" },
      }),
    ).toBeNull();
  });

  test("the Inbox order: back from parking, about what you're on, the rest, parked last", () => {
    const row = (id: string, patch: object = {}) => ({
      id,
      status: "triaged",
      returned: false,
      about: null,
      ...patch,
    });
    const sorted = sortInbox([
      row("plain"),
      row("parked", { status: "parked" }),
      row("other", { about: { kind: "other", itemId: "b", name: "B", current: "A" } }),
      row("mine", { about: { kind: "current", itemId: "a", name: "A" } }),
      row("back", { returned: true }),
    ]);
    expect(sorted.map((r) => r.id)).toEqual(["back", "mine", "plain", "other", "parked"]);
  });

  test("the next local day", () => {
    expect(nextLocalDay(new Date(2026, 9, 31, 23, 30))).toBe("2026-11-01");
  });
});

describe("parking round trip on the db (D62)", () => {
  test("park keeps proposals pending and out of Today; a change of current brings it back", async () => {
    const { run } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        const { cert, ops } = yield* twoItems;
        const other = yield* pasteAbout(ops, "Can you rotate the creds?");
        const mine = yield* pasteAbout(cert, "Cert ETA?");
        const about = yield* threadAbout(other);
        const aboutMine = yield* threadAbout(mine);
        const list = yield* listInbox();
        const badgeBefore = yield* pendingCount;

        const parked = yield* parkThread(other, null);
        const afterPark = yield* thread(other);
        const pending = yield* proposalsOf(other);
        const listParked = yield* listInbox();
        const badge = yield* pendingCount;
        const today = yield* loadTodayInputs();
        const parkedEvents = yield* eventsOf("parked");
        // Nothing changed: the pass keeps it parked.
        const quiet = yield* runWorkPass();

        // The user moves on to the other item: it comes back with its reason.
        yield* setCurrent(ops);
        const back = yield* runWorkPass();
        const afterBack = yield* thread(other);
        const listBack = yield* listInbox();
        const unparked = yield* eventsOf("unparked");
        return {
          cert,
          ops,
          other,
          mine,
          about,
          aboutMine,
          list,
          badgeBefore,
          parked,
          afterPark,
          pending,
          listParked,
          badge,
          today,
          parkedEvents,
          quiet,
          back,
          afterBack,
          listBack,
          unparked,
        };
      }),
    );
    expect(r.about).toMatchObject({ canPark: true, about: { kind: "other", itemId: r.ops } });
    expect(r.aboutMine).toMatchObject({ canPark: false, about: { kind: "current" } });
    // About what you're on sorts first.
    expect(r.list[0]?.id).toBe(r.mine);
    expect(r.list.find((i) => i.id === r.other)?.about?.kind).toBe("other");

    expect(r.parked?.reason).toBe("on Renew the payment cert");
    expect(r.afterPark).toMatchObject({
      status: "parked",
      parkedReason: "on Renew the payment cert",
      parkedUntil: nextLocalDay(new Date()),
    });
    // Nothing decided for the user.
    expect(r.pending.map((p) => [p.status, p.decidedAt])).toEqual([["pending", null]]);
    expect(r.listParked.at(-1)?.id).toBe(r.other);
    expect(r.badge).toBe(r.badgeBefore - 1);
    expect(r.today.threads.map((t) => t.id)).toEqual([r.mine]);
    expect(r.parkedEvents).toEqual([
      expect.objectContaining({ workItemId: r.ops, ref: r.other, actor: "me", applied: true }),
    ]);
    expect(r.quiet.returned).toBe(0);

    expect(r.back.returned).toBe(1);
    expect(r.afterBack).toMatchObject({
      status: "triaged",
      parkedReason: "on Renew the payment cert",
      parkedUntil: null,
    });
    expect(r.listBack[0]).toMatchObject({ id: r.other, returned: true });
    expect(r.unparked[0]?.summary).toContain("you moved on to");
  });

  test("the item closing brings it back; the user's words are the reason", async () => {
    const { run } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        const { ops } = yield* twoItems;
        const other = yield* pasteAbout(ops, "Rotate creds please");
        yield* parkThread(other, "  after the cert  ");
        const reason = (yield* thread(other))?.parkedReason;
        // PAY-12 is done in Jira: its item closes at the next pass.
        yield* query((d) =>
          d
            .update(jiraIssues)
            .set({ status: "Done", statusCategory: "done" })
            .where(eq(jiraIssues.key, "PAY-12")),
        );
        const pass = yield* runWorkPass();
        return {
          reason,
          pass,
          after: yield* thread(other),
          current: yield* currentItem(),
          why: (yield* eventsOf("unparked"))[0]?.summary,
        };
      }),
    );
    expect(r.reason).toBe("after the cert");
    expect(r.pass.returned).toBe(1);
    expect(r.after?.status).toBe("triaged");
    expect(r.current).toBeNull();
    expect(r.why).toContain('"Renew the payment cert" is done');
  });

  test("a new local day: current lapses and parked threads come back", async () => {
    const { run } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        const { cert, ops } = yield* twoItems;
        const other = yield* pasteAbout(ops, "Rotate creds please");
        yield* parkThread(other, null);
        const tomorrow = new Date(Date.now() + 86_400_000);
        const pass = yield* runWorkPass({ now: tomorrow });
        const item = yield* query((d) =>
          d.select().from(workItems).where(eq(workItems.id, cert)).get(),
        );
        return { pass, after: yield* thread(other), item };
      }),
    );
    expect(r.pass.returned).toBe(1);
    expect(r.after?.status).toBe("triaged");
    expect(r.item?.current).toBe(false);
  });

  test("no park without a current item, about the current item, or for a closed thread; Bring back", async () => {
    const { run } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        const { cert, ops } = yield* twoItems;
        const mine = yield* pasteAbout(cert, "Cert news");
        const other = yield* pasteAbout(ops, "Creds news");
        const aboutCurrent = yield* parkThread(mine, null);
        yield* query((d) =>
          d.update(inboxItems).set({ status: "filed" }).where(eq(inboxItems.id, other)),
        );
        const closed = yield* parkThread(other, null);
        yield* query((d) =>
          d.update(inboxItems).set({ status: "triaged" }).where(eq(inboxItems.id, other)),
        );
        yield* parkThread(other, null);
        const brought = yield* unparkThread(other, "brought back by you");
        const back = yield* thread(other);
        yield* setCurrent(null);
        const noCurrent = yield* parkThread(other, null);
        return { aboutCurrent, closed, brought, back, noCurrent, today: localDate() };
      }),
    );
    expect(r.aboutCurrent).toBeNull();
    expect(r.closed).toBeNull();
    expect(r.brought).toBe(true);
    expect(r.back?.status).toBe("triaged");
    expect(r.noCurrent).toBeNull();
  });
});

describe("the ration and parked questions (D62)", () => {
  test("a parked work thread's questions do not count, and it takes no new rationed one", async () => {
    const { run } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        const { cert, ops } = yield* twoItems;
        // OPS has a work thread with today's question in it; the ration is one a day.
        const opsThread = yield* workThread(ops, "Rotate");
        yield* postQuestion(opsThread, {
          question: "Is the rotation for prod only?",
          choices: [],
          work: { type: "meaning", itemId: ops },
        });
        const dayStart = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
        const full = yield* askQuestions({
          attach: [],
          meaning: [{ itemId: cert, question: "Who installs the cert?", choices: [] }],
          doubts: [],
          perDay: 1,
          dayStart,
        });
        // The user parks it (it is about other work): its question no longer counts.
        yield* parkThread(opsThread, null);
        const freed = yield* askQuestions({
          attach: [],
          meaning: [{ itemId: cert, question: "Who installs the cert?", choices: [] }],
          doubts: [],
          perDay: 1,
          dayStart,
        });
        // A new question about the parked item waits until it is back.
        const waits = yield* askQuestions({
          attach: [],
          meaning: [{ itemId: ops, question: "Which database first?", choices: [] }],
          doubts: [],
          perDay: 5,
          dayStart,
        });
        return { full, freed, waits, status: (yield* thread(opsThread))?.status };
      }),
    );
    expect(r.full).toHaveLength(0);
    expect(r.freed).toHaveLength(1);
    expect(r.waits).toHaveLength(0);
    expect(r.status).toBe("parked");
  });
});

/** `n` plain threads, newer than anything else in the test. */
const manyThreads = (n: number) =>
  query((d) =>
    d.insert(inboxItems).values(
      Array.from({ length: n }, (_, i) => ({
        id: `t-${String(i).padStart(3, "0")}`,
        source: "teams" as const,
        rawText: `Thread ${i}`,
        receivedAt: new Date(Date.now() + (i + 1) * 60_000).toISOString(),
        status: "triaged" as const,
      })),
    ),
  );

describe("review fixes (D62)", () => {
  test("parked and returned threads are listed past the page of 100; switch off, date order", async () => {
    const { run } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        const { ops } = yield* twoItems;
        const parked = yield* pasteAbout(ops, "Rotate creds please");
        const back = yield* pasteAbout(ops, "And the staging ones");
        yield* parkThread(parked, null);
        yield* parkThread(back, null);
        yield* unparkThread(back, "brought back by you");
        yield* manyThreads(105);
        return {
          parked,
          back,
          on: yield* listInbox(),
          off: yield* listInbox("", { against: false }),
        };
      }),
    );
    expect(r.on).toHaveLength(102);
    expect(r.on[0]).toMatchObject({ id: r.back, returned: true });
    expect(r.on.at(-1)).toMatchObject({ id: r.parked, status: "parked" });
    // Off: newest first, nothing lifted, the parked one still there, last.
    expect(r.off).toHaveLength(101);
    expect(r.off[0]?.id).toBe("t-104");
    expect(r.off.some((i) => i.id === r.back)).toBe(false);
    expect(r.off.every((i) => !i.returned && !i.about)).toBe(true);
    expect(r.off.at(-1)?.id).toBe(r.parked);
  });

  test("a returned thread leads only on the day it came back", async () => {
    const { run } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        const { ops } = yield* twoItems;
        const back = yield* pasteAbout(ops, "Rotate creds please");
        yield* parkThread(back, null);
        yield* unparkThread(back, "a new day", "secretary", new Date(Date.now() - 86_400_000));
        yield* manyThreads(2);
        return { back, list: yield* listInbox() };
      }),
    );
    expect(r.list.find((i) => i.id === r.back)?.returned).toBe(false);
    expect(r.list[0]?.id).not.toBe(r.back);
  });

  test("it returns to the status it had: a failed run stays new", async () => {
    const { run } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        const { ops } = yield* twoItems;
        const id = yield* pasteAbout(ops, "Rotate creds please");
        yield* query((d) =>
          d
            .update(inboxItems)
            .set({ status: "new", triage: { error: "The model is down" } })
            .where(eq(inboxItems.id, id)),
        );
        yield* parkThread(id, null);
        yield* unparkThread(id, "brought back by you");
        return yield* thread(id);
      }),
    );
    expect(r?.status).toBe("new");
  });

  test("with the work model off, the pass still brings parked threads back", async () => {
    const settings = defaultSettings();
    const r = await workTestLayer({}, { work: { ...settings.work, enabled: false } }).run(
      Effect.gen(function* () {
        yield* query((d) =>
          d.insert(inboxItems).values({
            id: "i-parked",
            source: "teams",
            rawText: "Rotate creds please",
            receivedAt: nowIso(),
            status: "parked",
            triage: { items: 1 },
            parkedReason: "on Cert",
            parkedUntil: "2099-01-01",
          }),
        );
        const pass = yield* runWorkPass();
        return { pass, after: yield* thread("i-parked") };
      }),
    );
    expect(r.pass).toMatchObject({ skipped: "disabled", returned: 1 });
    expect(r.after).toMatchObject({ status: "triaged", parkedUntil: null });
  });

  test("the Work tab's star reads current for today only", async () => {
    const { run } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        const { cert } = yield* twoItems;
        const today = (yield* workItemDetail("PAY-12"))?.item.current;
        yield* query((d) =>
          d
            .update(workItems)
            .set({ currentOn: localDate(new Date(Date.now() - 86_400_000)) })
            .where(eq(workItems.id, cert)),
        );
        return { today, stale: (yield* workItemDetail("PAY-12"))?.item.current };
      }),
    );
    expect(r).toEqual({ today: true, stale: false });
  });
});

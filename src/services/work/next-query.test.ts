/**
 * Next moves from the db (D62): a rule switched off still shows what it would
 * raise as a line (kept in the outcome memory), the current item's summary
 * for Today, and a draft's ticket's item for the Drafts page. No model call.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { dependencies, people, workItemIssues } from "@/db/schema";
import { localDate } from "@/lib/dates";
import { nowIso } from "@/lib/ids";
import { query } from "@/services/db";
import { backOn } from "@/services/dependencies/logic";
import { defaultSettings } from "@/services/settings/schema";
import { insertIssues, issue, seedSyncState, workTestLayer } from "@/test/work";
import { currentWork, movesOfItem, workOfKeys } from "./next-query";
import { mergeHeld } from "./outcomes";
import { runWorkPass } from "./pass";
import { setCurrent } from "./queries";
import { heldSituations, type RuleInput } from "./rules";

const TODAY = localDate();
const day = (n: number) => localDate(new Date(Date.now() + n * 86_400_000));

const itemOf = (key: string) =>
  Effect.map(
    query((d) => d.select().from(workItemIssues).where(eq(workItemIssues.issueKey, key)).get()),
    (m) => m?.workItemId ?? "",
  );

const seed = Effect.gen(function* () {
  yield* seedSyncState;
  yield* insertIssues([
    issue("PAY-12", { summary: "Renew the payment cert", dueDate: day(20), sprint: null }),
    issue("OPS-7", { summary: "Rotate the credentials" }),
  ]);
  yield* query((d) => d.insert(people).values({ id: "c-sarah", displayName: "Sarah Kim" }));
  yield* query((d) =>
    d.insert(dependencies).values({
      id: "w-cert",
      issueKey: "PAY-12",
      kind: "person",
      label: "the new cert",
      ownerPersonId: "c-sarah",
      status: "waiting",
      requestedAt: new Date(Date.now() - 10 * 86_400_000).toISOString(),
      nextFollowupAt: day(-2),
    }),
  );
});

describe("held lines (D62)", () => {
  test("heldSituations runs only the rules that are off or quiet", () => {
    const settings = defaultSettings();
    const input = {
      item: { id: "w1", name: "Cert" },
      facts: { today: TODAY, tickets: [], waits: [], people: [] },
      state: null,
      previous: null,
      newEvents: [],
      history: [],
      waits: [
        {
          id: "d1",
          issueKey: "PAY-12",
          label: "the cert",
          status: "waiting",
          externalRef: null,
          ownerPersonId: "c-sarah",
          ownerTeamId: null,
          ownerName: "Sarah Kim",
          ownerJira: null,
          requestedAt: nowIso(),
          expectedAt: null,
          nextFollowupAt: day(-1),
          lastFollowupAt: null,
          ownerAway: null,
        },
      ],
      blockedBy: {},
      statuses: {},
      contacts: new Map(),
      me: { username: "me", names: [] },
      pending: [],
      today: TODAY,
      settings,
      quiet: new Set(),
    } satisfies RuleInput;
    expect(heldSituations(input)).toEqual([]);
    const off = {
      ...settings,
      secretary: {
        ...settings.secretary,
        rules: { ...settings.secretary.rules, wait_unanswered: false },
      },
    };
    expect(heldSituations({ ...input, settings: off }).map((s) => s.rule)).toEqual([
      "wait_unanswered",
    ]);
    expect(
      heldSituations({ ...input, quiet: new Set(["wait_unanswered"] as const) }).map((s) => s.rule),
    ).toEqual(["wait_unanswered"]);
  });

  test("mergeHeld keeps a change-driven line for the day it was seen, while its rule is held", () => {
    const line = (
      rule: "expected_date_moved" | "wait_unanswered",
      key: string,
      seenOn: string,
    ) => ({
      rule,
      key,
      title: key,
      why: "",
      keys: [],
      waits: [],
      facts: {},
      seenOn,
    });
    const prev = [
      line("expected_date_moved", "moved-today", TODAY),
      line("expected_date_moved", "moved-yesterday", day(-1)),
      line("wait_unanswered", "chase", TODAY),
    ];
    expect(mergeHeld([], prev, () => true, TODAY).map((h) => h.key)).toEqual(["moved-today"]);
    expect(mergeHeld([], prev, () => false, TODAY)).toEqual([]);
  });
});

describe("next moves from the db (D62)", () => {
  test("a switched-off rule's chase is a line; Today's summary and the Drafts line", async () => {
    const settings = defaultSettings();
    const { run, models } = workTestLayer(
      {},
      {
        secretary: {
          ...settings.secretary,
          rules: { ...settings.secretary.rules, wait_unanswered: false },
        },
      },
    );
    const r = await run(
      Effect.gen(function* () {
        yield* seed;
        yield* runWorkPass();
        const cert = yield* itemOf("PAY-12");
        const moves = yield* movesOfItem(cert);
        const none = yield* currentWork();
        yield* setCurrent(cert);
        const summary = yield* currentWork();
        const line = yield* workOfKeys(["NOPE-1", "PAY-12"]);
        const noLine = yield* workOfKeys(["NOPE-1"]);
        return { cert, moves, none, summary, line, noLine };
      }),
    );
    expect(models.calls).toHaveLength(0);
    expect(r.moves.map((m) => [m.kind, m.bucket, m.waitId])).toEqual([
      // The chase the rule would offer, shown as a line; the plain wait is not repeated.
      ["held", "overdue", "w-cert"],
      ["ticket", "later", null],
    ]);
    expect(r.moves[0]?.text).toContain("Sarah Kim");
    expect(r.none).toBeNull();
    expect(r.summary).toMatchObject({
      id: r.cert,
      current: true,
      issueKey: "PAY-12",
      moves: r.moves,
    });
    expect(r.line).toMatchObject({ id: r.cert, current: true });
    expect(r.noLine).toBeNull();
  });

  test("an away owner's wait is a move for the day they are back (D47)", async () => {
    const { run } = workTestLayer();
    const r = await run(
      Effect.gen(function* () {
        yield* seed;
        yield* query((d) =>
          d
            .update(people)
            .set({ awayUntil: day(5) })
            .where(eq(people.id, "c-sarah")),
        );
        yield* runWorkPass();
        return yield* movesOfItem(yield* itemOf("PAY-12"));
      }),
    );
    const wait = r.find((m) => m.waitId === "w-cert");
    expect(wait).toMatchObject({ kind: "wait", on: backOn(day(5)), bucket: "later" });
    expect(wait?.text).toBe("Follow up with Sarah Kim for the new cert");
  });
});

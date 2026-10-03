import { describe, expect, test } from "bun:test";
import { backOn, chaseNotes, groupByOwner, mirrorUrl, nextFollowupAfter, timing } from "./logic";

describe("dependency timing", () => {
  test("a dependency expected yesterday is one day overdue (FR-3 AC)", () => {
    expect(
      timing({ status: "open", expectedAt: "2026-09-24", nextFollowupAt: null }, "2026-09-25"),
    ).toEqual({
      overdueDays: 1,
      followupDue: false,
      followupLateDays: 0,
      asleep: false,
      awayUntil: null,
      backSince: null,
      followupOn: null,
      reason: null,
    });
  });

  test("future and resolved dependencies are not overdue; follow-ups due today count", () => {
    expect(
      timing(
        { status: "waiting", expectedAt: "2026-09-30", nextFollowupAt: "2026-09-25" },
        "2026-09-25",
      ),
    ).toMatchObject({
      overdueDays: 0,
      followupDue: true,
      followupLateDays: 0,
    });
    expect(
      timing(
        { status: "resolved", expectedAt: "2026-01-01", nextFollowupAt: "2026-01-01" },
        "2026-09-25",
      ).overdueDays,
    ).toBe(0);
  });
});

describe("groupByOwner", () => {
  const ana = { type: "person" as const, id: "p1", name: "Ana" };
  const plat = { type: "team" as const, id: "t1", name: "Platform" };
  test("groups by owner, most overdue group and item first, resolved last", () => {
    const groups = groupByOwner(
      [
        { id: "a", status: "open", expectedAt: "2026-09-24", nextFollowupAt: null, owner: ana },
        {
          id: "b",
          status: "waiting",
          expectedAt: "2026-09-10",
          nextFollowupAt: "2026-09-20",
          owner: plat,
        },
        {
          id: "c",
          status: "resolved",
          expectedAt: "2026-09-01",
          nextFollowupAt: null,
          owner: plat,
        },
        { id: "d", status: "open", expectedAt: "2026-09-20", nextFollowupAt: null, owner: plat },
      ],
      "2026-09-25",
    );
    expect(groups.map((g) => g.owner.name)).toEqual(["Platform", "Ana"]);
    expect(groups[0]?.items.map((i) => [i.id, i.timing.overdueDays])).toEqual([
      ["b", 15],
      ["d", 5],
      ["c", 0],
    ]);
    expect(groups[0]?.due).toBe(1);
  });
});

describe("mirroring and chasing", () => {
  test("remote link URL falls back to team page, then mailto", () => {
    expect(mirrorUrl({ externalUrl: "https://snow/INC1" }, {})).toBe("https://snow/INC1");
    expect(mirrorUrl({ externalUrl: null }, { teamUrls: ["https://wiki/plat"] })).toBe(
      "https://wiki/plat",
    );
    expect(mirrorUrl({ externalUrl: null }, { personEmail: "ana@example.com" })).toBe(
      "mailto:ana@example.com",
    );
    expect(mirrorUrl({ externalUrl: null }, {})).toBeNull();
  });

  test("chase notes name the incident, the ask and the first request date (FR-6 AC)", () => {
    expect(
      chaseNotes({
        label: "Platform fix",
        externalRef: "INC0012345",
        issueKey: "PAY-2",
        requestedAt: "2026-09-10",
        expectedAt: "2026-09-20",
      }),
    ).toBe(
      "Chase Platform fix (INC0012345) for PAY-2. First requested on 2026-09-10. Was expected by 2026-09-20.",
    );
  });
});

describe("timing with the owner's away date (D47)", () => {
  // 2026-10-01 is a Thursday.
  const bob = { name: "Bob", awayUntil: "2026-10-01" };
  const wait = {
    status: "waiting" as const,
    expectedAt: "2026-09-28",
    nextFollowupAt: "2026-09-29",
    requestedAt: "2026-09-25T09:00:00.000Z",
    lastFollowupAt: "2026-09-29T10:00:00.000Z",
    ownerAway: bob,
  };

  test("away until tomorrow: asleep today, not overdue, no follow-up due", () => {
    expect(timing(wait, "2026-09-30")).toEqual({
      overdueDays: 0,
      followupDue: false,
      followupLateDays: 0,
      asleep: true,
      awayUntil: "2026-10-01",
      backSince: null,
      followupOn: "2026-10-02",
      reason: "Bob is away until 1 Oct",
    });
    // The last day away still sleeps.
    expect(timing(wait, "2026-10-01").asleep).toBe(true);
  });

  test("due with the reason on the first working day after", () => {
    expect(timing(wait, "2026-10-02")).toEqual({
      overdueDays: 4,
      followupDue: true,
      followupLateDays: 0,
      asleep: false,
      awayUntil: null,
      backSince: "2026-10-02",
      followupOn: "2026-10-02",
      reason: "Bob is back",
    });
    // Still due, and later, until a follow-up is logged.
    expect(timing(wait, "2026-10-05")).toMatchObject({
      followupDue: true,
      followupLateDays: 3,
      reason: "Bob is back",
    });
  });

  test("away until a Friday: back on Monday, asleep over the weekend", () => {
    const fri = { ...wait, ownerAway: { name: "Bob", awayUntil: "2026-10-02" } };
    expect(backOn("2026-10-02")).toBe("2026-10-05");
    expect(timing(fri, "2026-10-04").asleep).toBe(true);
    expect(timing(fri, "2026-10-05")).toMatchObject({ backSince: "2026-10-05", followupDue: true });
  });

  test("a follow-up logged since they came back ends 'is back'", () => {
    const chased = {
      ...wait,
      lastFollowupAt: "2026-10-02T11:00:00.000Z",
      nextFollowupAt: "2026-10-07",
    };
    expect(timing(chased, "2026-10-05")).toMatchObject({
      followupDue: false,
      backSince: null,
      reason: null,
      followupOn: "2026-10-07",
    });
  });

  test("a wait opened after they came back is timed as usual: an old date needs no clearing", () => {
    const later = {
      ...wait,
      requestedAt: "2026-10-03T08:00:00.000Z",
      nextFollowupAt: "2026-10-08",
    };
    expect(timing(later, "2026-10-05")).toMatchObject({
      asleep: false,
      followupDue: false,
      reason: null,
    });
  });

  test("no away date, a resolved wait or a malformed date: no away state", () => {
    expect(timing({ ...wait, ownerAway: null }, "2026-09-30")).toMatchObject({
      asleep: false,
      overdueDays: 2,
      followupDue: true,
    });
    expect(timing({ ...wait, status: "resolved" }, "2026-09-30").asleep).toBe(false);
    expect(
      timing({ ...wait, ownerAway: { name: "Bob", awayUntil: "soon" } }, "2026-09-30").asleep,
    ).toBe(false);
  });

  test("groups list sleeping waits after the awake ones", () => {
    const owner = { type: "person" as const, id: "p1", name: "Bob" };
    const groups = groupByOwner(
      [
        { ...wait, id: "asleep", owner },
        { ...wait, id: "awake", ownerAway: null, owner },
      ],
      "2026-09-30",
    );
    expect(groups[0]?.items.map((i) => i.id)).toEqual(["awake", "asleep"]);
  });
});

describe("nextFollowupAfter (D46)", () => {
  test("the date asked for, else the working day after a new expected date, else the default", () => {
    expect(nextFollowupAfter({ nextFollowupAt: "2026-10-09", expectedAt: "2026-10-02" })).toBe(
      "2026-10-09",
    );
    expect(nextFollowupAfter({ nextFollowupAt: null, expectedAt: "2026-10-02" })).toBe(
      "2026-10-05",
    );
    expect(nextFollowupAfter({ nextFollowupAt: null, expectedAt: null })).toBeUndefined();
  });
});

import { describe, expect, test } from "bun:test";
import { chaseNotes, groupByOwner, mirrorUrl, timing } from "./logic";

describe("dependency timing", () => {
  test("a dependency expected yesterday is one day overdue (FR-3 AC)", () => {
    expect(
      timing({ status: "open", expectedAt: "2026-09-24", nextFollowupAt: null }, "2026-09-25"),
    ).toEqual({
      overdueDays: 1,
      followupDue: false,
      followupLateDays: 0,
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

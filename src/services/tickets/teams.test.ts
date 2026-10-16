import { describe, expect, test } from "bun:test";
import { latestTeams, SYNCED_ONLY, teamOptions } from "./teams";

describe("latestTeams (D59)", () => {
  test("each id once with its latest name, by name; rows without an id are left out", () => {
    expect(
      latestTeams([
        { teamId: "13", team: "Platform", updated: "2026-10-01T00:00:00Z" },
        { teamId: "12", team: "Payments (old)", updated: "2026-09-01T00:00:00Z" },
        { teamId: "12", team: "Payments", updated: "2026-10-02T00:00:00Z" },
        { teamId: "12", team: "Payments (older)", updated: "2026-08-01T00:00:00Z" },
        { teamId: null, team: "Data", updated: "2026-10-03T00:00:00Z" },
      ]),
    ).toEqual([
      { id: "12", name: "Payments" },
      { id: "13", name: "Platform" },
    ]);
  });
});

describe("teamOptions (D59)", () => {
  const synced = [
    { id: "12", name: "Payments" },
    { id: "13", name: "Platform" },
  ];

  test("no text: every synced team, no search", () => {
    expect(teamOptions({ synced, text: "", search: null, searchFailed: false })).toEqual({
      synced,
      found: [],
      note: null,
    });
  });

  test("typed text filters the synced teams; one character does not search", () => {
    const r = teamOptions({
      synced,
      text: "p",
      search: [{ id: "14", name: "Data" }],
      searchFailed: false,
    });
    expect(r).toEqual({ synced, found: [], note: null });
    expect(teamOptions({ synced, text: "plat", search: null, searchFailed: false }).synced).toEqual(
      [{ id: "13", name: "Platform" }],
    );
  });

  test("search results join, without the synced teams", () => {
    const r = teamOptions({
      synced,
      text: "pa",
      search: [
        { id: "12", name: "Payments" },
        { id: "15", name: "Partners" },
      ],
      searchFailed: false,
    });
    expect(r.synced).toEqual([{ id: "12", name: "Payments" }]);
    expect(r.found).toEqual([{ id: "15", name: "Partners" }]);
    expect(r.note).toBeNull();
  });

  test("a failed or empty search says only synced teams are offered", () => {
    expect(teamOptions({ synced, text: "pay", search: null, searchFailed: true }).note).toBe(
      SYNCED_ONLY,
    );
    expect(teamOptions({ synced, text: "pay", search: [], searchFailed: false }).note).toBe(
      SYNCED_ONLY,
    );
    // Still waiting for the search: no note yet.
    expect(teamOptions({ synced, text: "pay", search: null, searchFailed: false }).note).toBeNull();
  });

  test("Data Center's 'Team <id>' names take the search's name and stay synced (review)", () => {
    const dc = [
      { id: "12", name: "Team 12" },
      { id: "13", name: "Team 13" },
    ];
    const r = teamOptions({
      synced: dc,
      text: "pay",
      search: [{ id: "12", name: "Payments" }],
      searchFailed: false,
    });
    expect(r).toEqual({ synced: [{ id: "12", name: "Payments" }], found: [], note: null });
    // A real synced name is kept even when the search names the id differently.
    expect(
      teamOptions({
        synced: [{ id: "12", name: "Payments" }],
        text: "",
        search: [{ id: "12", name: "Payments EU" }],
        searchFailed: false,
      }).synced,
    ).toEqual([{ id: "12", name: "Payments" }]);
  });
});

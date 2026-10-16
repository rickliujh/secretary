import { describe, expect, test } from "bun:test";
import { teamNamed } from "./team-name";

describe("teamNamed (D59)", () => {
  const teams = [
    { id: "t1", name: "Platform" },
    { id: "t2", name: " Payments Core " },
  ];

  test("matches ignoring case and surrounding spaces", () => {
    expect(teamNamed(teams, "platform")?.id).toBe("t1");
    expect(teamNamed(teams, "payments core")?.id).toBe("t2");
    expect(teamNamed(teams, "  PLATFORM ")?.id).toBe("t1");
  });

  test("no match, an empty name or none is null", () => {
    expect(teamNamed(teams, "Payments")).toBeNull();
    expect(teamNamed(teams, " ")).toBeNull();
    expect(teamNamed(teams, null)).toBeNull();
    expect(teamNamed([], "Platform")).toBeNull();
  });
});

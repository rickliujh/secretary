import { describe, expect, test } from "bun:test";
import { compactLine, isCompact } from "./compact";
import { ProposalPayloadSchema } from "./schema";

const names = {
  person: (id: string) => (id === "p-bob" ? "Bob Ray" : null),
  team: (id: string) => (id === "t-plat" ? "Platform" : null),
};
const parse = (v: unknown) => ProposalPayloadSchema.parse(v);

describe("compact dependency rows (D46)", () => {
  const resolve = parse({
    kind: "update_dependency",
    dependencyId: "d1",
    action: "resolve",
    summary: "Bob sent the numbers",
    issueKey: "PAY-2",
    label: "Q3 numbers",
  });

  test("a change to a wait and a wait on an existing ticket are compact; one on a new ticket is not", () => {
    expect(isCompact(resolve)).toBe(true);
    const dep = { kind: "link_dependency", dependencyKind: "person", label: "Numbers" };
    expect(isCompact(parse({ ...dep, target: "PAY-2" }))).toBe(true);
    expect(isCompact(parse({ ...dep, target: "$new:1" }))).toBe(false);
    expect(isCompact(parse({ kind: "add_comment", target: "PAY-2", bodyMd: "x" }))).toBe(false);
  });

  test("the line says what happens to which wait, and what they said", () => {
    expect(compactLine(resolve, names)).toBe(
      "Resolve: PAY-2 waits on Q3 numbers — “Bob sent the numbers”",
    );
    expect(
      compactLine(
        parse({
          kind: "update_dependency",
          dependencyId: "d1",
          action: "reschedule",
          expectedAt: "2026-10-09",
          nextFollowupAt: "2026-10-12",
          issueKey: "PAY-2",
          label: "Q3 numbers",
        }),
        names,
      ),
    ).toBe("Reschedule PAY-2 waits on Q3 numbers: expected 2026-10-09, ask again 2026-10-12");
    expect(
      compactLine(
        parse({
          kind: "link_dependency",
          target: "PAY-2",
          dependencyKind: "team",
          label: "Firewall change",
          ownerTeamId: "t-plat",
          expectedAt: "2026-10-09",
        }),
        names,
      ),
    ).toBe("PAY-2 waits on Firewall change (Platform), expected 2026-10-09");
  });
});

import { describe, expect, test } from "bun:test";
import { pickWaits, WAIT_LIMIT, type WaitRow } from "./waits";

const row = (id: string, p: Partial<WaitRow> = {}): WaitRow => ({
  id,
  issueKey: "OPS-7",
  label: "Something",
  kind: "person",
  externalRef: null,
  status: "waiting",
  ownerPersonId: null,
  ownerTeamId: null,
  owner: null,
  ownerPersonTeamId: null,
  ownerAwayUntil: null,
  requestedAt: "2026-09-20T09:00:00.000Z",
  expectedAt: null,
  nextFollowupAt: null,
  issueSummary: null,
  ...p,
});
const ctx = {
  senderPersonId: "p-bob",
  senderTeamId: "t-fin",
  namedPersonIds: [] as string[],
  candidateKeys: ["PAY-2"],
  mentionedKeys: [] as string[],
  quote: "Here are the Q3 numbers you asked for.",
  today: "2026-10-03",
};

describe("pickWaits (D46)", () => {
  test("the sender's wait first, then the team's, the candidate ticket's and matching words; others left out", () => {
    const picked = pickWaits(
      [
        row("unrelated", { label: "Vendor quote" }),
        row("words", { label: "Q3 numbers for the board" }),
        row("ticket", { issueKey: "PAY-2", label: "Firewall" }),
        row("team", { ownerTeamId: "t-fin", owner: "Finance", label: "Budget sign-off" }),
        row("bob", { ownerPersonId: "p-bob", owner: "Bob Ray", label: "Numbers from finance" }),
        row("done", { ownerPersonId: "p-bob", status: "resolved" }),
      ],
      ctx,
    );
    expect(picked.map((w) => [w.id, w.reasons])).toEqual([
      ["bob", ["sender", "wording"]],
      ["team", ["team"]],
      ["ticket", ["ticket"]],
      ["words", ["wording"]],
    ]);
    expect(picked[0]).toMatchObject({ owner: "Bob Ray", requestedOn: "2026-09-20" });
  });

  test("a named contact and an incident number in the text count", () => {
    const picked = pickWaits(
      [
        row("ana", { ownerPersonId: "p-ana", owner: "Ana" }),
        row("inc", { externalRef: "INC0012345", ownerTeamId: "t-plat", owner: "Platform" }),
      ],
      {
        ...ctx,
        senderPersonId: null,
        senderTeamId: null,
        namedPersonIds: ["p-ana"],
        quote: "INC0012345 is fixed",
      },
    );
    expect(picked.map((w) => [w.id, w.reasons])).toEqual([
      ["ana", ["named"]],
      ["inc", ["wording"]],
    ]);
  });

  test("capped, and the owner's away date only while away", () => {
    const many = Array.from({ length: WAIT_LIMIT + 3 }, (_, i) =>
      row(`w${i}`, {
        ownerPersonId: "p-bob",
        ownerAwayUntil: i === 0 ? "2026-10-14" : "2026-09-01",
      }),
    );
    const picked = pickWaits(many, ctx);
    expect(picked).toHaveLength(WAIT_LIMIT);
    expect(picked.find((w) => w.id === "w0")?.awayUntil).toBe("2026-10-14");
    expect(picked.find((w) => w.id === "w1")?.awayUntil).toBeNull();
  });
});

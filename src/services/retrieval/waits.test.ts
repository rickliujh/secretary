import { describe, expect, test } from "bun:test";
import { mentionsRef, pickWaits, sameWaitSubject, WAIT_LIMIT, type WaitRow } from "./waits";

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

  test("an incident number matches only as a whole reference", () => {
    const pick = (quote: string) =>
      pickWaits(
        [row("inc", { externalRef: "INC0012", ownerTeamId: "t-plat", owner: "Platform" })],
        { ...ctx, senderPersonId: null, senderTeamId: null, quote },
      ).map((w) => w.id);
    expect(pick("INC00123 is fixed")).toEqual([]);
    expect(pick("XINC0012 is fixed")).toEqual([]);
    expect(pick("inc0012 is fixed")).toEqual(["inc"]);
    expect(pick("Fixed (INC0012).")).toEqual(["inc"]);
    expect(mentionsRef("see REQ-1.2", "REQ-1.2")).toBe(true);
    expect(mentionsRef("see REQ-1x2", "REQ-1.2")).toBe(false);
  });

  test("two waits are about the same thing by reference or shared words", () => {
    const a = { label: "Q3 numbers from finance", externalRef: null };
    expect(sameWaitSubject(a, { label: "Finance numbers", externalRef: null })).toBe(true);
    expect(sameWaitSubject(a, { label: "Contract sign-off", externalRef: null })).toBe(false);
    // The owner's name alone is not a subject.
    expect(
      sameWaitSubject(
        { label: "Answer from Ana", externalRef: null },
        { label: "Access for Ana", externalRef: null },
        "Ana Bell",
      ),
    ).toBe(false);
    // When both have a reference, it decides.
    const inc = { label: "Platform fix", externalRef: "INC0012345" };
    expect(sameWaitSubject(inc, { label: "Platform fix", externalRef: "inc0012345" })).toBe(true);
    expect(sameWaitSubject(inc, { label: "Platform fix", externalRef: "INC0099999" })).toBe(false);
    expect(sameWaitSubject(inc, { label: "Chase INC0012345", externalRef: null })).toBe(true);
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

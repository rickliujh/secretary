import { describe, expect, test } from "bun:test";
import { cleanInput, extractReferences, needsSegmentation } from "./preprocess";

describe("cleanInput", () => {
  test("drops quoted reply history and > lines", () => {
    const raw =
      "Can you chase PAY-2?\r\n\r\nOn Mon, 21 Sep 2026 at 09:00, Ana Bell <ana@example.com> wrote:\r\n> earlier text\r\n> more";
    expect(cleanInput(raw)).toBe("Can you chase PAY-2?");
  });

  test("drops Outlook headers of forwarded history", () => {
    const raw =
      "FYI the ledger export is blocked.\n\nFrom: Tom Kay\nSent: 20 September 2026 10:00\nTo: Rick\nSubject: old";
    expect(cleanInput(raw)).toBe("FYI the ledger export is blocked.");
  });

  test("drops sign-offs and short signature blocks, and -- delimited signatures", () => {
    expect(
      cleanInput("Please update OPS-7.\n\nKind regards,\nTom Kay\nNetwork team\n+44 20 0000 0000"),
    ).toBe("Please update OPS-7.");
    expect(cleanInput("Done.\n-- \nAna | Payments")).toBe("Done.");
  });

  test("keeps a sign-off word that is part of the message", () => {
    expect(
      cleanInput(
        "Thanks\nalso please move PAY-4 to done, it shipped yesterday and the customer confirmed the fix works",
      ),
    ).toContain("PAY-4");
  });

  test("normalises whitespace", () => {
    expect(cleanInput("a  \n\n\n\nb c ")).toBe("a\n\nb c");
  });
});

describe("extractReferences", () => {
  const contacts = [
    { id: "p1", displayName: "Ana Bell", email: "ana@example.com", jiraUsername: "ana.b" },
    { id: "p2", displayName: "Tom Kay", email: null, jiraUsername: "tom.k" },
    { id: "p3", displayName: "Tom Reed", email: null, jiraUsername: null },
    { id: "p4", displayName: "Priya Shah", email: null, jiraUsername: "priya.s" },
  ];

  test("issue keys, browse URLs and ServiceNow numbers; ignores look-alikes", () => {
    const r = extractReferences(
      "PAY-2 blocked by INC0012345 (see https://jira.example.com/browse/OPS-7). UTF-8 and ISO-8601 are not keys. RITM0001234 too.",
    );
    expect(r.issueKeys).toEqual(["PAY-2", "OPS-7"]);
    expect(r.tickets).toEqual(["INC0012345", "RITM0001234"]);
    expect(r.urls).toEqual(["https://jira.example.com/browse/OPS-7"]);
  });

  test("contacts by full name, email, @username, and unique first name only", () => {
    const r = extractReferences(
      "Ana will check; ping @priya.s and tom.k. Tom said hi. Mail ana@example.com",
      contacts,
    );
    expect(r.contactIds.sort()).toEqual(["p1", "p2", "p4"]);
    expect(r.emails).toEqual(["ana@example.com"]);
    // "Tom" alone is ambiguous (two Toms), so p3 is not matched.
    expect(r.contactIds).not.toContain("p3");
  });
});

describe("needsSegmentation", () => {
  test("short inputs are single items", () => {
    expect(needsSegmentation("Please comment on PAY-2 that we are blocked.")).toBe(false);
    expect(needsSegmentation(Array.from({ length: 12 }, (_, i) => `line ${i}`).join("\n"))).toBe(
      true,
    );
  });
});

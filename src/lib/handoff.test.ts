import { describe, expect, test } from "bun:test";
import {
  handoffFits,
  handoffLink,
  handoffRecipients,
  MAILTO_MAX_LENGTH,
  mailtoUrl,
  TEAMS_MAX_LENGTH,
  teamsChatUrl,
} from "./handoff";

/** The decoded query parameters of a link. */
const params = (url: string) => new URLSearchParams(url.slice(url.indexOf("?") + 1));

describe("teamsChatUrl", () => {
  test("opens a chat with the person and the message", () =>
    expect(teamsChatUrl(["anna@example.com"], "Hi Anna")).toBe(
      "https://teams.microsoft.com/l/chat/0/0?users=anna@example.com&message=Hi%20Anna",
    ));

  test("several people make a comma-separated group chat", () =>
    expect(teamsChatUrl(["a@x.com", " b@y.com "], "Hi")).toBe(
      "https://teams.microsoft.com/l/chat/0/0?users=a@x.com,b@y.com&message=Hi",
    ));

  test("encodes spaces as %20, never +", () => {
    const url = teamsChatUrl(["a@x.com"], "a b+c");
    expect(url).toContain("message=a%20b%2Bc");
    expect(params(url).get("message")).toBe("a b+c");
  });

  test("ampersands, equals signs, hashes and quotes stay inside the message", () => {
    const text = `R&D said "done" = yes #1 it's fine?`;
    const url = teamsChatUrl(["a@x.com"], text);
    expect(url).not.toContain("R&D");
    expect(url).not.toContain("#");
    expect(params(url).get("message")).toBe(text);
  });

  test("non-ASCII text is UTF-8 percent-encoded", () => {
    const url = teamsChatUrl(["a@x.com"], "Grüße 你好");
    expect(url).toContain("Gr%C3%BC%C3%9Fe%20%E4%BD%A0%E5%A5%BD");
    expect(params(url).get("message")).toBe("Grüße 你好");
  });

  test("line breaks become encoded LF", () => {
    const url = teamsChatUrl(["a@x.com"], "one\r\ntwo\nthree");
    expect(url).toContain("one%0Atwo%0Athree");
  });

  test("an empty message leaves the parameter out", () =>
    expect(teamsChatUrl(["a@x.com"], "")).toBe(
      "https://teams.microsoft.com/l/chat/0/0?users=a@x.com",
    ));

  test("odd characters in an address are encoded", () =>
    expect(teamsChatUrl(["a&b@x.com"], "")).toContain("users=a%26b@x.com"));

  test("needs at least one address", () => {
    expect(() => teamsChatUrl([], "Hi")).toThrow();
    expect(() => teamsChatUrl([" "], "Hi")).toThrow();
  });
});

describe("mailtoUrl", () => {
  test("recipients, subject and body", () =>
    expect(
      mailtoUrl({ to: ["a@x.com", "b@y.com"], subject: "Status update", body: "Hi all" }),
    ).toBe("mailto:a@x.com,b@y.com?subject=Status%20update&body=Hi%20all"));

  test("encodes spaces as %20, never +", () => {
    const url = mailtoUrl({ to: ["a@x.com"], subject: "a b", body: "c d+e" });
    expect(url).not.toContain("+");
    expect(url).toContain("body=c%20d%2Be");
  });

  test("ampersands, question marks and quotes do not break the query", () => {
    const url = mailtoUrl({ to: ["a@x.com"], subject: `Q&A: "why?"`, body: "x=1&y=2 #3" });
    expect(params(url).get("subject")).toBe(`Q&A: "why?"`);
    expect(params(url).get("body")).toBe("x=1&y=2 #3");
  });

  test("non-ASCII subject and body", () => {
    const url = mailtoUrl({ to: ["a@x.com"], subject: "Grüße", body: "你好，世界" });
    expect(url).toContain("subject=Gr%C3%BC%C3%9Fe");
    expect(params(url).get("body")).toBe("你好，世界");
  });

  test("line breaks become CRLF", () => {
    const url = mailtoUrl({ to: ["a@x.com"], body: "one\ntwo\r\nthree\rfour" });
    expect(url).toBe("mailto:a@x.com?body=one%0D%0Atwo%0D%0Athree%0D%0Afour");
  });

  test("no subject leaves the parameter out", () => {
    expect(mailtoUrl({ to: ["a@x.com"], subject: null, body: "Hi" })).toBe(
      "mailto:a@x.com?body=Hi",
    );
    expect(mailtoUrl({ to: ["a@x.com"], subject: "  ", body: "Hi" })).toBe(
      "mailto:a@x.com?body=Hi",
    );
  });

  test("nothing but the address when there is no text", () =>
    expect(mailtoUrl({ to: ["a@x.com"], body: "" })).toBe("mailto:a@x.com"));

  test("needs at least one address", () =>
    expect(() => mailtoUrl({ to: [], body: "x" })).toThrow());
});

describe("handoffFits", () => {
  test("mailto links up to the mailto limit", () => {
    const base = "mailto:a@x.com?body=";
    expect(handoffFits(base + "x".repeat(MAILTO_MAX_LENGTH - base.length))).toBe(true);
    expect(handoffFits(base + "x".repeat(MAILTO_MAX_LENGTH - base.length + 1))).toBe(false);
  });

  test("Teams links up to the Teams limit", () => {
    const base = teamsChatUrl(["a@x.com"], "");
    expect(handoffFits(base + "x".repeat(TEAMS_MAX_LENGTH - base.length))).toBe(true);
    expect(handoffFits(base + "x".repeat(TEAMS_MAX_LENGTH - base.length + 1))).toBe(false);
  });

  test("encoding counts: non-ASCII text grows the link", () => {
    const text = "你".repeat(250); // 9 characters each once encoded
    expect(handoffFits(mailtoUrl({ to: ["a@x.com"], body: text }))).toBe(false);
  });
});

describe("handoffLink", () => {
  test("a short message goes in the link", () =>
    expect(handoffLink("email", { to: ["a@x.com"], subject: "S", body: "Hi" })).toEqual({
      url: "mailto:a@x.com?subject=S&body=Hi",
      bodyIncluded: true,
    }));

  test("Teams ignores the subject", () =>
    expect(handoffLink("teams", { to: ["a@x.com"], subject: "S", body: "Hi" })).toEqual({
      url: "https://teams.microsoft.com/l/chat/0/0?users=a@x.com&message=Hi",
      bodyIncluded: true,
    }));

  test("a long email opens without the body but keeps the subject", () =>
    expect(
      handoffLink("email", { to: ["a@x.com"], subject: "S", body: "x".repeat(MAILTO_MAX_LENGTH) }),
    ).toEqual({ url: "mailto:a@x.com?subject=S", bodyIncluded: false }));

  test("a long Teams message opens the chat without it", () =>
    expect(handoffLink("teams", { to: ["a@x.com"], body: "x".repeat(TEAMS_MAX_LENGTH) })).toEqual({
      url: "https://teams.microsoft.com/l/chat/0/0?users=a@x.com",
      bodyIncluded: false,
    }));

  test("drops an oversized subject too", () =>
    expect(
      handoffLink("email", {
        to: ["a@x.com"],
        subject: "s".repeat(MAILTO_MAX_LENGTH),
        body: "Hi",
      }),
    ).toEqual({ url: "mailto:a@x.com", bodyIncluded: false }));
});

describe("handoffRecipients", () => {
  test("a person with an email", () =>
    expect(handoffRecipients({ person: { email: " anna@example.com " }, team: null })).toEqual({
      to: ["anna@example.com"],
    }));
  test("a person without an email", () => {
    expect(handoffRecipients({ person: { email: null }, team: null })).toEqual({
      blocked: "no-email",
    });
    expect(handoffRecipients({ person: { email: "  " }, team: null })).toEqual({
      blocked: "no-email",
    });
  });
  test("a team has no address", () =>
    expect(handoffRecipients({ person: null, team: { id: "t1" } })).toEqual({ blocked: "team" }));
  test("no recipient", () =>
    expect(handoffRecipients({ person: null, team: null })).toEqual({ blocked: "no-recipient" }));
});

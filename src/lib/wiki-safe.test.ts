import { describe, expect, test } from "bun:test";
import { markdownToWiki } from "./wiki";
import { mentionId, sanitiseProposalWiki, wikiSafetyWarning } from "./wiki-safe";

const known = ["ana.b", "5b10ac8d82e05b22cc7d4ef5", null];
const safe = (wiki: string) => sanitiseProposalWiki(wiki, known);
const fromMd = (md: string) => safe(markdownToWiki(md));

describe("sanitiseProposalWiki: images", () => {
  test("a Markdown image becomes a plain link", () => {
    expect(fromMd("See ![](https://x.io/p.png) here")).toEqual({
      wiki: "See [https://x.io/p.png] here",
      images: ["https://x.io/p.png"],
      mentions: [],
    });
  });

  test("a Markdown image with alt text and title keeps only the URL", () => {
    expect(fromMd('![chart](https://x.io/p.png "Q3")').wiki).toBe("[https://x.io/p.png]");
  });

  test("a wiki image embed becomes a plain link", () => {
    expect(safe("!http://x.io/p.png!").wiki).toBe("[http://x.io/p.png]");
  });

  test("an embed with attributes drops them", () => {
    expect(safe("before !https://x.io/p.png|width=1,height=1! after")).toMatchObject({
      wiki: "before [https://x.io/p.png] after",
      images: ["https://x.io/p.png"],
    });
  });

  test("protocol-relative, upper-case and data URLs count as remote", () => {
    const r = safe("!//x.io/a.png! !HTTPS://X.IO/B.PNG! !data:image/png;base64,AAAA!");
    expect(r.wiki).toBe("[//x.io/a.png] [HTTPS://X.IO/B.PNG] [data:image/png;base64,AAAA]");
    expect(r.images).toHaveLength(3);
  });

  test("an attachment name (no scheme) is the issue's own file and stays", () => {
    expect(safe("!screenshot.png! and !image-2024.png|thumbnail!")).toEqual({
      wiki: "!screenshot.png! and !image-2024.png|thumbnail!",
      images: [],
      mentions: [],
    });
  });

  test("exclamation marks in prose do not hide a later embed", () => {
    expect(safe("Hello!world and !https://x.io/p.png!").wiki).toBe(
      "Hello!world and [https://x.io/p.png]",
    );
    expect(safe("Great! Thanks!").wiki).toBe("Great! Thanks!");
  });

  test("brackets in the URL cannot break out of the link", () => {
    expect(safe("!https://x.io/a]b.png!").wiki).toBe("[https://x.io/a%5Db.png]");
  });
});

describe("sanitiseProposalWiki: mentions", () => {
  test("a known Data Center username stays a mention", () => {
    expect(safe("Thanks [~ana.b] and [~ANA.B]")).toEqual({
      wiki: "Thanks [~ana.b] and [~ANA.B]",
      images: [],
      mentions: [],
    });
  });

  test("an unknown Data Center username becomes literal text", () => {
    expect(safe("ping [~jsmith] please")).toEqual({
      wiki: "ping \\[~jsmith] please",
      images: [],
      mentions: ["jsmith"],
    });
  });

  test("a known Cloud account id stays, with or without the prefix in the known list", () => {
    expect(safe("[~accountid:5b10ac8d82e05b22cc7d4ef5] ok").mentions).toEqual([]);
    expect(sanitiseProposalWiki("[~accountid:abc123]", ["accountid:abc123"]).mentions).toEqual([]);
  });

  test("an unknown Cloud account id becomes literal text", () => {
    expect(safe("cc [~accountid:557058:f00d]")).toEqual({
      wiki: "cc \\[~accountid:557058:f00d]",
      images: [],
      mentions: ["accountid:557058:f00d"],
    });
  });

  test("an aliased user link counts as a mention", () => {
    expect(safe("[John|~jsmith] and [Ana|~ana.b]").wiki).toBe("\\[John|~jsmith] and [Ana|~ana.b]");
  });

  test("a mention already escaped is left as it is", () => {
    expect(safe("\\[~jsmith]")).toMatchObject({ wiki: "\\[~jsmith]", mentions: [] });
  });

  test("Markdown text carrying a mention is handled after conversion", () => {
    expect(fromMd("**Ask** [~jsmith] about it").wiki).toBe("*Ask* \\[~jsmith] about it");
  });

  test("mention ids compare without the Cloud prefix or case", () => {
    expect(mentionId(" AccountId:ABC ")).toBe("abc");
  });
});

describe("sanitiseProposalWiki: what stays", () => {
  test("ordinary formatting, links, lists, tables and keys are untouched", () => {
    const wiki = markdownToWiki(
      "## Plan\n\n**bold**, *it*, `code` and [site](https://x.io)\n\n- PAY-2\n- INC0012345\n\n| a | b |\n| --- | --- |\n| 1 | 2 |",
    );
    expect(safe(wiki)).toEqual({ wiki, images: [], mentions: [] });
  });

  test("code and noformat blocks render literally and are left alone", () => {
    const code = "```\n![](https://x.io/p.png)\n[~jsmith]\n```";
    expect(fromMd(code)).toEqual({
      wiki: "{code}\n!https://x.io/p.png!\n[~jsmith]\n{code}",
      images: [],
      mentions: [],
    });
    const mixed = "{noformat}\n!https://x.io/a.png!\n{noformat}\n!https://x.io/b.png!";
    expect(safe(mixed).wiki).toBe(
      "{noformat}\n!https://x.io/a.png!\n{noformat}\n[https://x.io/b.png]",
    );
    expect(safe("{code:js}[~jsmith]{code} [~jsmith]").wiki).toBe(
      "{code:js}[~jsmith]{code} \\[~jsmith]",
    );
  });

  test("inline monospace is not a literal block, so it is still made safe", () => {
    expect(safe("{{!https://x.io/p.png!}}").wiki).toBe("{{[https://x.io/p.png]}}");
  });
});

describe("wikiSafetyWarning", () => {
  test("nothing changed, no warning", () => {
    expect(wikiSafetyWarning({ images: [], mentions: [] }, "comment")).toBeNull();
  });

  test("says what changed and where", () => {
    expect(
      wikiSafetyWarning({ images: ["https://a"], mentions: ["jsmith", "jsmith"] }, "comment"),
    ).toBe(
      "In the comment, 1 remote image became a link and the mention of jsmith became plain text (not a Jira user Secretary knows).",
    );
    expect(wikiSafetyWarning({ images: ["a", "b"], mentions: [] }, "description")).toBe(
      "In the description, 2 remote images became links.",
    );
  });
});

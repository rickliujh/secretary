import { describe, expect, test } from "bun:test";
import { markdownToWiki, wikiToMarkdown } from "./wiki";

describe("markdownToWiki", () => {
  test("headings, emphasis, code, links", () => {
    expect(markdownToWiki("## Plan\n\n**bold**, *italic*, `code` and [site](https://x.io)")).toBe(
      "h2. Plan\n\n*bold*, _italic_, {{code}} and [site|https://x.io]",
    );
  });

  test("dash and plus bullets, including nesting, become star bullets", () => {
    expect(markdownToWiki("- one\n  - two\n    + three\n- four")).toBe(
      "* one\n** two\n*** three\n* four",
    );
  });

  test("numbered lists", () => {
    expect(markdownToWiki("1. a\n2. b")).toBe("# a\n# b");
  });

  test("GFM tables become wiki tables", () => {
    expect(markdownToWiki("| Name | Status |\n| --- | :---: |\n| PAY-2 | Blocked |\n\nafter")).toBe(
      "||Name||Status||\n|PAY-2|Blocked|\n\nafter",
    );
  });

  test("fenced code keeps its content, including dashes", () => {
    const wiki = markdownToWiki("before\n\n```bash\n- not a bullet\n| a | b |\n```\n\n- bullet");
    expect(wiki).toContain("{code:bash}\n- not a bullet\n| a | b |\n{code}");
    expect(wiki).toEndWith("* bullet");
  });

  test("issue keys and incident numbers pass through", () => {
    expect(markdownToWiki("Blocked by INC0012345, see ABC-12")).toBe(
      "Blocked by INC0012345, see ABC-12",
    );
  });
});

describe("wikiToMarkdown", () => {
  test("common wiki markup", () => {
    expect(
      wikiToMarkdown("h3. Scope\r\n* invoices\r\n** refunds\r\n{{code}} [text|https://x.io]"),
    ).toBe("### Scope\n* invoices\n  * refunds\n`code` [text](https://x.io)");
  });
});

import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { sanitizeJiraHtml } from "./html";

const win = new JSDOM("").window as unknown as Window;

describe("sanitizeJiraHtml", () => {
  test("strips scripts and handlers, absolutises links, turns images into links", () => {
    const out = sanitizeJiraHtml(
      '<p onclick="x()">Hi <script>alert(1)</script><a href="/browse/PAY-2">PAY-2</a> <img src="/secure/attachment/1/a.png" alt="diagram"></p>',
      "https://jira.example.com/",
      win,
    );
    expect(out).not.toContain("script");
    expect(out).not.toContain("onclick");
    expect(out).toContain('href="https://jira.example.com/browse/PAY-2"');
    expect(out).toContain('href="https://jira.example.com/secure/attachment/1/a.png"');
    expect(out).toContain("[image: diagram]");
    expect(out).not.toContain("<img");
  });

  test("keeps Jira formatting markup", () => {
    const out = sanitizeJiraHtml(
      "<h3>Scope</h3><ul><li><b>a</b></li></ul><tt>INC1</tt>",
      "https://j",
      win,
    );
    expect(out).toBe("<h3>Scope</h3><ul><li><b>a</b></li></ul><tt>INC1</tt>");
  });

  test("falls back to escaped text when the DOM cannot support sanitising", () => {
    const out = sanitizeJiraHtml("<script>x</script>", "https://j", {} as Window);
    expect(out).toBe("<pre>&#60;script&#62;x&#60;/script&#62;</pre>");
  });
});

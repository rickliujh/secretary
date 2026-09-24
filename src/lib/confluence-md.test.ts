import { describe, expect, test } from "bun:test";
import { preprocessStorage, storageToMarkdown } from "./confluence-md";

const PAGE = `<h1>Payments platform</h1>
<p>Owned by <ac:link><ri:user ri:userkey="8a8b8c8d" /></ac:link>. See <ac:link><ri:page ri:content-title="Escalation runbook" /><ac:plain-text-link-body><![CDATA[the runbook]]></ac:plain-text-link-body></ac:link> and <a href="/display/PAY/Home">home</a>.</p>
<ac:structured-macro ac:name="info" ac:schema-version="1"><ac:parameter ac:name="title">Contact</ac:parameter><ac:rich-text-body><p>Raise a <strong>ServiceNow</strong> ticket for access.</p></ac:rich-text-body></ac:structured-macro>
<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">bash</ac:parameter><ac:plain-text-body><![CDATA[curl -H "X: <a>" https://pay.example.com
echo done]]></ac:plain-text-body></ac:structured-macro>
<table><tbody><tr><th>System</th><th>Owner</th></tr><tr><td>Ledger</td><td>Ana</td></tr></tbody></table>
<ac:task-list><ac:task><ac:task-id>1</ac:task-id><ac:task-status>complete</ac:task-status><ac:task-body>Document SLAs</ac:task-body></ac:task><ac:task><ac:task-id>2</ac:task-id><ac:task-status>incomplete</ac:task-status><ac:task-body>Add on-call rota</ac:task-body></ac:task></ac:task-list>
<p>Status: <ac:structured-macro ac:name="status"><ac:parameter ac:name="title">GREEN</ac:parameter></ac:structured-macro> since <time datetime="2026-09-01" />, tracked in <ac:structured-macro ac:name="jira"><ac:parameter ac:name="key">PAY-1</ac:parameter></ac:structured-macro>.</p>
<ac:structured-macro ac:name="toc" />
<p><ac:image><ri:attachment ri:filename="architecture.png" /></ac:image></p>
<ul><li>First</li><li>Second<ul><li>Nested</li></ul></li></ul>`;

describe("preprocessStorage", () => {
  test("escapes CDATA and expands self-closing macro tags", () => {
    expect(preprocessStorage('<ri:page ri:content-title="A" /><x><![CDATA[a<b]]></x>')).toBe(
      '<ri:page ri:content-title="A"></ri:page><x>a&lt;b</x>',
    );
  });
});

describe("storageToMarkdown", () => {
  const md = storageToMarkdown(PAGE, { baseUrl: "https://wiki.example.com/" });

  test("headings, links and users", () => {
    expect(md).toStartWith("# Payments platform");
    expect(md).toContain("Owned by @user. See the runbook and [home](https://wiki.example.com/display/PAY/Home).");
  });

  test("info panels become labelled blockquotes", () => {
    expect(md).toContain("> **Info: Contact**\n>\n> Raise a **ServiceNow** ticket for access.");
  });

  test("code macros keep their text verbatim in a fenced block", () => {
    expect(md).toContain('```bash\ncurl -H "X: <a>" https://pay.example.com\necho done\n```');
  });

  test("tables become GFM tables", () => {
    expect(md).toContain("| System | Owner |");
    expect(md).toContain("| Ledger | Ana |");
  });

  test("task lists, status, dates and jira macros", () => {
    expect(md).toContain("- [x] Document SLAs\n- [ ] Add on-call rota");
    expect(md).toContain("Status: [GREEN] since 2026-09-01, tracked in PAY-1.");
  });

  test("images become placeholders and navigation macros are dropped", () => {
    expect(md).toContain("(image: architecture.png)");
    expect(md).not.toContain("toc");
  });

  test("nested lists", () => {
    expect(md).toContain("- First\n- Second\n  - Nested");
  });
});

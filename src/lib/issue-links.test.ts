import { describe, expect, test } from "bun:test";
import { fromMarkdown } from "mdast-util-from-markdown";
import { remarkIssueLinks, ticketOfUrl } from "./issue-links";

type Node = { type: string; url?: string; value?: string; children?: Node[] };
const links = (md: string, known: string[]) => {
  const tree = fromMarkdown(md) as unknown as Node;
  remarkIssueLinks(new Set(known))()(tree as never);
  const out: string[] = [];
  const walk = (n: Node) => {
    if (n.type === "link" && n.url) out.push(n.url);
    for (const c of n.children ?? []) walk(c);
  };
  walk(tree);
  return out;
};

describe("ticket keys in Markdown", () => {
  test("links keys of synced tickets only, and leaves code and existing links alone", () => {
    expect(
      links(
        "- Finish **PAY-4** and chase OPS-7 (UTF-8, ISO-8601, PAY-999)\n- `PAY-4` in code\n- [see PAY-4](https://x.test)",
        ["PAY-4", "OPS-7"],
      ),
    ).toEqual(["ticket:PAY-4", "ticket:OPS-7", "https://x.test"]);
  });

  test("ticketOfUrl reads the key back", () => {
    expect(ticketOfUrl("ticket:PAY-4")).toBe("PAY-4");
    expect(ticketOfUrl("https://x.test")).toBeNull();
  });
});

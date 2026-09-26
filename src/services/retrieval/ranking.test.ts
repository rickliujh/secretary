import { describe, expect, test } from "bun:test";
import {
  mergeCandidates,
  orderPriorities,
  overlap,
  rankByRelevance,
  rankMemories,
  retrievalFtsQuery,
  tokens,
} from "./ranking";

describe("retrieval ranking", () => {
  test("tokens drop stopwords, short words and bare numbers", () => {
    expect(tokens("Can you please chase the ledger export by 2026? It's blocked")).toEqual([
      "chase",
      "ledger",
      "export",
      "blocked",
    ]);
  });

  test("FTS query ORs quoted prefixes", () => {
    expect(retrievalFtsQuery('ledger "export" ledger')).toBe('"ledger"* OR "export"*');
    expect(retrievalFtsQuery("the and of")).toBeNull();
  });

  test("merge keeps priority order, collects reasons and never drops mentions", () => {
    const merged = mergeCandidates(
      [
        ["search", ["A-1", "A-2", "A-3"]],
        ["recent", ["A-2", "A-4"]],
        ["mentioned", ["A-9"]],
      ],
      3,
    );
    expect([...merged.keys()]).toEqual(["A-1", "A-2", "A-3", "A-9"]);
    expect(merged.get("A-2")).toEqual(["search", "recent"]);
  });

  test("relevance favours overlap, then weight and recency", () => {
    const now = Date.parse("2026-09-24T00:00:00Z");
    const ranked = rankByRelevance(
      [
        { id: 1, text: "billing migration tickets go under PAY-1", at: "2026-01-01T00:00:00Z" },
        { id: 2, text: "prefer short messages to Tom", at: "2026-09-23T00:00:00Z" },
        { id: 3, text: "unrelated", weight: 3, at: "2026-09-23T00:00:00Z" },
      ],
      "new billing migration task",
      2,
      now,
    );
    expect(ranked.map((r) => r.id)).toEqual([1, 3]);
    expect(overlap("a b c", "")).toBe(0);
  });

  test("memories about something in the item rank above loosely related ones", () => {
    const m = (id: string, text: string, subjectType: string | null, subjectId: string | null) => ({
      id,
      text,
      subjectType,
      subjectId,
      weight: 1,
      at: "2026-09-20T00:00:00Z",
    });
    const ranked = rankMemories(
      [
        m("loose", "Ledger exports are slow on Mondays", null, null),
        m("about", "Always copy Priya on escalations", "person", "p-priya"),
        m("other", "Tom prefers email", "person", "p-tom"),
      ],
      "ledger export blocked, escalate to Priya",
      new Set(["person:p-priya", "issue:PAY-2"]),
      2,
      Date.parse("2026-09-24T00:00:00Z"),
    );
    expect(ranked.map((r) => r.id)).toEqual(["about", "loose"]);
  });

  test("priorities follow Jira's usual order", () => {
    expect(orderPriorities(["Low", "Custom", "Highest", "Medium", "Low"])).toEqual([
      "Highest",
      "Medium",
      "Low",
      "Custom",
    ]);
  });
});

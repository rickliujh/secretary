/** Today and the work model (D61): rows name their work item; the item the user is on comes first. */
import { describe, expect, test } from "bun:test";
import { DEFAULT_WEIGHTS } from "@/services/settings/schema";
import { mixedInputs, NOW, TODAY } from "@/test/today-fixture";
import { buildToday } from "./today";

const keyOf = (r: { issue?: { key: string } | null; dependency?: { issueKey: string } }) =>
  r.issue?.key ?? r.dependency?.issueKey ?? null;

describe("Today names work items", () => {
  test("rows carry their item, and the current item's rows lead each list", () => {
    const plain = buildToday(mixedInputs(), DEFAULT_WEIGHTS, TODAY, NOW);
    const workItems = new Map([
      ["SPR-2", { id: "w-cur", name: "Vendor rollout", current: true }],
      ["SPR-1", { id: "w-other", name: "Billing", current: false }],
    ]);
    const t = buildToday(mixedInputs({ workItems }), DEFAULT_WEIGHTS, TODAY, NOW);
    // The same rows as without work items, reordered only.
    expect(t.theirMove.map(keyOf).sort()).toEqual(plain.theirMove.map(keyOf).sort());
    const first = t.theirMove[0];
    expect(first && keyOf(first)).toBe("SPR-2");
    expect(first?.workItem).toEqual({ id: "w-cur", name: "Vendor rollout", current: true });
    const billing = t.theirMove.find((r) => keyOf(r) === "SPR-1");
    expect(billing?.workItem?.name).toBe("Billing");
    // Rows of the current item keep their order among themselves; the rest keep theirs.
    const rest = t.theirMove.filter((r) => keyOf(r) !== "SPR-2").map(keyOf);
    expect(rest).toEqual(plain.theirMove.filter((r) => keyOf(r) !== "SPR-2").map(keyOf));
  });
});

describe("Today and outcome cards (Phase 25)", () => {
  type Rule = "wait_unanswered" | "blocker_closed" | "teammate_touched";
  const outcome = (
    id: string,
    rule: Rule,
    p: { keys?: string[]; waits?: string[]; comments?: string[]; steps?: number } = {},
  ) => ({
    id,
    rule,
    title: `Card ${id}`,
    why: "why",
    itemName: "Vendor rollout",
    workItemId: "w-cur",
    steps: p.steps ?? 2,
    keys: p.keys ?? [],
    waits: p.waits ?? [],
    comments: p.comments ?? [],
    at: NOW,
  });
  const ticketKeys = (rows: readonly object[]) =>
    rows.flatMap((r) => ("issue" in r ? [(r as { issue: { key: string } }).issue.key] : []));
  const waitIds = (rows: readonly { kind: string }[]) =>
    rows.flatMap((r) =>
      r.kind === "wait" ? [(r as unknown as { dependency: { id: string } }).dependency.id] : [],
    );
  const withIds = mixedInputs().comments.map((c, i) => ({ ...c, id: `c${i}` }));

  test("a card leads Your move and hides only the rows it is about", () => {
    const workItems = new Map([["SPR-2", { id: "w-cur", name: "Vendor rollout", current: false }]]);
    const plain = buildToday(
      mixedInputs({ workItems, comments: withIds }),
      DEFAULT_WEIGHTS,
      TODAY,
      NOW,
    );
    const t = buildToday(
      mixedInputs({
        workItems,
        comments: withIds,
        outcomes: [
          outcome("o1", "wait_unanswered", { keys: ["SPR-2"], waits: ["d-follow"] }),
          outcome("o2", "blocker_closed", { keys: ["WOKE-1"], steps: 0 }),
          outcome("o3", "teammate_touched", { keys: ["CMT-1"], comments: ["c1"] }),
        ],
      }),
      DEFAULT_WEIGHTS,
      TODAY,
      NOW,
    );
    expect(t.yourMove.slice(0, 3).map((r) => [r.kind, r.reason])).toEqual([
      ["outcome", "2 steps to approve"],
      ["outcome", "to read"],
      ["outcome", "2 steps to approve"],
    ]);
    expect(t.yourMove[0]?.workItem?.name).toBe("Vendor rollout");
    expect(ticketKeys(plain.yourMove)).toEqual(expect.arrayContaining(["WOKE-1", "CMT-1"]));
    expect(ticketKeys(t.yourMove)).not.toContain("WOKE-1");
    expect(ticketKeys(t.yourMove)).not.toContain("CMT-1");
    // The card is about d-follow: SPR-2's other wait (d-back) stays.
    expect(waitIds(plain.theirMove)).toEqual(expect.arrayContaining(["d-follow", "d-back"]));
    expect(waitIds(t.theirMove)).not.toContain("d-follow");
    expect(waitIds(t.theirMove)).toContain("d-back");
  });

  test("a card never hides what it is not about", () => {
    const t = buildToday(
      mixedInputs({
        comments: withIds,
        outcomes: [
          // A chase card naming WOKE-1 and CMT-1 hides neither, nor any wait but its own.
          outcome("o1", "wait_unanswered", { keys: ["WOKE-1", "CMT-1"], waits: ["nope"] }),
          // A teammate card about another comment leaves CMT-1's row.
          outcome("o2", "teammate_touched", { keys: ["CMT-1"], comments: ["c-other"] }),
        ],
      }),
      DEFAULT_WEIGHTS,
      TODAY,
      NOW,
    );
    expect(ticketKeys(t.yourMove)).toEqual(expect.arrayContaining(["WOKE-1", "CMT-1"]));
    expect(waitIds(t.theirMove)).toEqual(expect.arrayContaining(["d-follow", "d-back", "d-over"]));
  });

  test("an outcome card is not listed again as a thread", () => {
    const t = buildToday(
      mixedInputs({ outcomes: [outcome("t1", "wait_unanswered")] }),
      DEFAULT_WEIGHTS,
      TODAY,
      NOW,
    );
    expect(t.yourMove.filter((r) => r.kind === "thread")).toEqual([]);
  });
});

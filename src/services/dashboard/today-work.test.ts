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

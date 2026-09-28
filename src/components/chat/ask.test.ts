import { describe, expect, test } from "bun:test";
import { askSearch, claimAsk } from "./ask";

describe("askSearch", () => {
  test("opens a new conversation with the question", () => {
    expect(askSearch("Plan my day", "c1")).toEqual({ c: "c1", ask: "Plan my day" });
  });

  test("gives each call a fresh conversation id", () => {
    const a = askSearch("Plan my day");
    const b = askSearch("Plan my day");
    expect(a.c).not.toBe(b.c);
    expect(a.ask).toBe("Plan my day");
  });
});

describe("claimAsk", () => {
  test("claims a question once per conversation", () => {
    expect(claimAsk("conv-a", "hello")).toBe(true);
    expect(claimAsk("conv-a", "hello")).toBe(false);
  });

  test("keeps conversations and questions apart", () => {
    expect(claimAsk("conv-b", "hello")).toBe(true);
    expect(claimAsk("conv-b", "other")).toBe(true);
    expect(claimAsk("conv-c", "hello")).toBe(true);
  });
});

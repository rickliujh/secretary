import { describe, expect, test } from "bun:test";
import { applyChange, minimalChange } from "./doc-change";

const roundTrip = (a: string, b: string) => {
  const c = minimalChange(a, b);
  expect(c ? applyChange(a, c) : a).toBe(b);
  return c;
};

describe("minimalChange (D67)", () => {
  test("equal texts need no change", () => {
    expect(minimalChange("same\n", "same\n")).toBeNull();
  });

  test("an append is an insert at the end", () => {
    expect(roundTrip("line one\n", "line one\nnote this\n")).toEqual({
      from: 9,
      to: 9,
      insert: "note this\n",
    });
  });

  test("a change in the middle keeps the prefix and the suffix", () => {
    expect(roundTrip("a\nfrom Obsidian\nc\n", "a\nfrom the vault\nc\n")).toEqual({
      from: 7,
      to: 15,
      insert: "the vault",
    });
  });

  test("repeated characters do not overlap prefix and suffix", () => {
    roundTrip("aaa", "aaaa");
    roundTrip("aaaa", "aa");
    roundTrip("", "x\r\ny");
    roundTrip("x\r\ny", "");
    roundTrip("abcabc", "abc");
  });

  test("line endings and whitespace stay byte for byte", () => {
    roundTrip("one\r\ntwo\r\n", "one\r\ntwo\r\nthree  \r\n");
    roundTrip("tabs\there", "tabs\t\there");
  });

  test("never splits a surrogate pair", () => {
    const c = roundTrip("x😀y", "x😁y");
    expect(c?.insert).toBe("😁");
  });
});

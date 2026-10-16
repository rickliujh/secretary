import { describe, expect, test } from "bun:test";
import { onSelect } from "./select-change";

describe("onSelect", () => {
  test("passes a chosen value on", () => {
    const seen: string[] = [];
    onSelect((v) => seen.push(v))("4");
    expect(seen).toEqual(["4"]);
  });

  test("ignores the empty value a form's native select reports", () => {
    const seen: string[] = [];
    onSelect((v) => seen.push(v))("");
    expect(seen).toEqual([]);
  });
});

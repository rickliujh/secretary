import { describe, expect, test } from "bun:test";
import { isSubmitEnter } from "./keys";

const key = (k: string, shiftKey = false, isComposing = false) => ({
  key: k,
  shiftKey,
  nativeEvent: { isComposing },
});

describe("isSubmitEnter", () => {
  test("plain Enter submits", () => expect(isSubmitEnter(key("Enter"))).toBe(true));
  test("Shift+Enter is a new line", () => expect(isSubmitEnter(key("Enter", true))).toBe(false));
  test("Enter during IME composition does not submit", () =>
    expect(isSubmitEnter(key("Enter", false, true))).toBe(false));
  test("other keys do not submit", () => expect(isSubmitEnter(key("a"))).toBe(false));
});

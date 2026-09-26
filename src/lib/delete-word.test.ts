import { expect, test } from "bun:test";
import { wordStartBefore } from "./delete-word";

test("deletes back to the previous whitespace, like a terminal", () => {
  const text = "move PAY-12 to review  ";
  expect(wordStartBefore(text, 11)).toBe(5); // "PAY-12"
  expect(wordStartBefore(text, text.length)).toBe(15); // "review" and the trailing spaces
  expect(wordStartBefore(text, 4)).toBe(0);
  expect(wordStartBefore(text, 0)).toBe(0);
  expect(wordStartBefore("a\nfoo.bar", 9)).toBe(2);
});

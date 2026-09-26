import { afterEach, describe, expect, test } from "bun:test";
import {
  clearRegisteredSecrets,
  redact,
  redactHeaders,
  redactValue,
  registerSecret,
} from "./redact";

afterEach(clearRegisteredSecrets);

describe("redact", () => {
  test("removes registered secret values wherever they appear", () => {
    registerSecret("NjY0MzI1ODk2OTk3OrandomPAT");
    expect(redact("request failed with token NjY0MzI1ODk2OTk3OrandomPAT in url")).toBe(
      "request failed with token [redacted] in url",
    );
  });

  test("ignores very short values so ordinary text survives", () => {
    registerSecret("abc");
    expect(redact("abc def")).toBe("abc def");
  });

  test("scrubs bearer tokens and key-shaped strings even when not registered", () => {
    expect(redact("Authorization: Bearer abcdefghijklmnop")).toBe(
      "Authorization: Bearer [redacted]",
    );
    expect(redact("key sk-ant-api03-abcdefghijklmnopqrstuvwxyz")).toBe("key [redacted]");
  });

  test("blanks sensitive headers", () => {
    expect(redactHeaders({ Authorization: "Bearer x", "X-Api-Key": "k", Accept: "json" })).toEqual({
      Authorization: "[redacted]",
      "X-Api-Key": "[redacted]",
      Accept: "json",
    });
  });

  test("deep-redacts objects", () => {
    registerSecret("super-secret-value");
    expect(
      redactValue({ a: ["super-secret-value"], headers: { authorization: "x" }, n: 1 }),
    ).toEqual({ a: ["[redacted]"], headers: { authorization: "[redacted]" }, n: 1 });
  });
});

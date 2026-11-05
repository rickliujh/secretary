import { describe, expect, test } from "bun:test";
import { base64ToBytes, bytesToBase64 } from "./base64";

describe("base64", () => {
  test("round trips every byte value", () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  test("matches the standard alphabet with padding", () => {
    expect(bytesToBase64(new TextEncoder().encode("hi"))).toBe("aGk=");
    expect(bytesToBase64(new Uint8Array())).toBe("");
    expect(new TextDecoder().decode(base64ToBytes("aW1n"))).toBe("img");
  });

  test("round trips more than one chunk", () => {
    const big = Uint8Array.from({ length: 100_003 }, (_, i) => (i * 31) % 256);
    expect(base64ToBytes(bytesToBase64(big))).toEqual(big);
  });

  test("refuses text that is not base64", () => {
    expect(() => base64ToBytes("not base64!")).toThrow();
  });
});

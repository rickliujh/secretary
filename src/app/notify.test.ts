import { describe, expect, test } from "bun:test";
import { osNotificationsUsable } from "./notify";

describe("osNotificationsUsable", () => {
  test("only a dev build on macOS skips OS notifications", () => {
    expect(osNotificationsUsable(true, true)).toBe(false);
    expect(osNotificationsUsable(true, false)).toBe(true);
    expect(osNotificationsUsable(false, true)).toBe(true);
    expect(osNotificationsUsable(false, false)).toBe(true);
  });
});

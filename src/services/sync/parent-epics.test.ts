import { describe, expect, test } from "bun:test";
import { type EpicRef, parentEpicsToRead } from "./parent-epics";

const NOW = "2026-10-15T10:00:00.000Z";
const BEFORE = "2026-10-14T10:00:00.000Z";
const row = (key: string, epicKey: string | null, over: Partial<EpicRef> = {}): EpicRef => ({
  key,
  epicKey,
  stale: false,
  syncedAt: NOW,
  ...over,
});

describe("parentEpicsToRead", () => {
  test("an epic referenced by a synced issue but not stored is read", () => {
    const rows = [row("AB-1", "AB-9"), row("AB-2", "AB-9"), row("AB-3", "AB-5"), row("AB-5", null)];
    expect(parentEpicsToRead(rows, { full: false, syncedAt: NOW })).toEqual(["AB-9"]);
  });

  test("an incremental run skips stored epics but reads stale ones again", () => {
    const rows = [
      row("AB-1", "AB-5", { syncedAt: BEFORE }),
      row("AB-5", null, { syncedAt: BEFORE }),
      row("AB-2", "AB-6"),
      row("AB-6", null, { stale: true, syncedAt: BEFORE }),
    ];
    expect(parentEpicsToRead(rows, { full: false, syncedAt: NOW })).toEqual(["AB-6"]);
  });

  test("a full run reads out-of-scope epics again and ignores issues it did not read", () => {
    const rows = [
      row("AB-1", "AB-5"),
      row("AB-5", null, { syncedAt: BEFORE }),
      row("AB-2", "AB-6", { syncedAt: BEFORE }),
    ];
    expect(parentEpicsToRead(rows, { full: true, syncedAt: NOW })).toEqual(["AB-5"]);
  });

  test("stale issues ask for nothing and odd keys are dropped", () => {
    const rows = [
      row("AB-1", "AB-5", { stale: true }),
      row("AB-2", "ab-6"),
      row("AB-3", "AB-6) OR x"),
    ];
    expect(parentEpicsToRead(rows, { full: false, syncedAt: NOW })).toEqual([]);
  });

  test("keys come back once, in numeric order", () => {
    const rows = [row("AB-1", "AB-10"), row("AB-2", "AB-9"), row("AB-3", "AB-10")];
    expect(parentEpicsToRead(rows, { full: false, syncedAt: NOW })).toEqual(["AB-9", "AB-10"]);
  });
});

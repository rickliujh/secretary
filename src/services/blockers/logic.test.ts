import { describe, expect, test } from "bun:test";
import { blockInfo, blockLinks, type IssueLink } from "@/services/dashboard/sections";
import {
  type BlockerMap,
  nextWakeState,
  openBlockers,
  parseBlockers,
  parseLinkTypes,
  pickBlocksType,
  unblockReason,
  type WakeState,
  type WokenRow,
  wokenTickets,
} from "./logic";

const BLOCKS = { name: "Blocks", inward: "is blocked by", outward: "blocks" };
const linked = (key: string, category: string) => ({
  key,
  fields: { status: { name: category, statusCategory: { key: category } } },
});
const blockedBy = (
  key: string,
  category = "indeterminate",
  id = "1",
): IssueLink & { id: string } => ({
  id,
  type: BLOCKS,
  inwardIssue: linked(key, category),
});
const blocks = (key: string, category = "new", id = "2"): IssueLink & { id: string } => ({
  id,
  type: BLOCKS,
  outwardIssue: linked(key, category),
});

describe("block links (D45)", () => {
  test("directions come from the side the other issue is on, whatever its status", () => {
    const links = [
      blockedBy("PLAT-1", "done", "10"),
      blocks("PAY-9", "new", "11"),
      {
        type: { name: "Relates", inward: "relates to", outward: "relates to" },
        inwardIssue: linked("X-1", "new"),
      },
    ];
    expect(blockLinks(links)).toEqual([
      { id: "10", key: "PLAT-1", direction: "blockedBy", statusCategory: "done" },
      { id: "11", key: "PAY-9", direction: "blocks", statusCategory: "new" },
    ]);
  });

  test("blockInfo prefers the fresh state over the status embedded in the link", () => {
    const links = [blockedBy("PLAT-1", "indeterminate"), blockedBy("PLAT-2", "done")];
    expect(blockInfo(links).blockedBy).toEqual(["PLAT-1"]);
    // PLAT-1 closed since the issue was fetched; PLAT-2 reopened.
    const fresh = { "PLAT-1": { statusCategory: "done" }, "PLAT-2": { statusCategory: "new" } };
    expect(blockInfo(links, fresh).blockedBy).toEqual(["PLAT-2"]);
    expect(openBlockers(blockLinks(links), fresh)).toEqual(["PLAT-2"]);
  });

  test("the blocks link type: Jira's default first, else by name or words", () => {
    const relates = { id: "1", name: "Relates", inward: "relates to", outward: "relates to" };
    const def = { id: "2", name: "Blocks", inward: "is blocked by", outward: "blocks" };
    const custom = { id: "3", name: "Dependency", inward: "is blocked by", outward: "blocks" };
    expect(pickBlocksType([relates, custom, def])).toEqual(custom);
    expect(pickBlocksType([relates, { ...def, inward: "waits for", outward: "gates" }])?.id).toBe(
      "2",
    );
    expect(pickBlocksType([relates])).toBeNull();
    expect(parseLinkTypes(undefined)).toEqual({ blocks: null });
    expect(parseLinkTypes(JSON.stringify({ blocks: def }))).toEqual({ blocks: def });
    expect(parseBlockers("not json")).toEqual({});
  });
});

describe("wake-up", () => {
  const blank: WakeState = {
    openBlockers: null,
    unblockedAt: null,
    unblockedBy: null,
    unblockNotifiedAt: null,
  };
  const map: BlockerMap = {
    "PLAT-1": { status: "Done", statusCategory: "done", resolvedAt: "2026-10-02T12:00:00.000Z" },
    "PLAT-2": { status: "Closed", statusCategory: "done", resolvedAt: "2026-10-01T12:00:00.000Z" },
  };
  const at = "2026-10-02T13:00:00.000Z";

  test("the first time blockers are seen nothing wakes", () => {
    expect(nextWakeState(blank, ["PLAT-1"], map, at)).toEqual({
      ...blank,
      openBlockers: ["PLAT-1"],
    });
    expect(nextWakeState(blank, [], map, at)).toEqual({ ...blank, openBlockers: [] });
  });

  test("the last open blocker closing wakes it, naming the one that closed last", () => {
    const asleep = { ...blank, openBlockers: ["PLAT-2", "PLAT-1"] };
    expect(nextWakeState(asleep, [], map, at)).toEqual({
      openBlockers: [],
      unblockedAt: at,
      unblockedBy: "PLAT-1",
      unblockNotifiedAt: null,
    });
    // One of two closing is not enough.
    expect(nextWakeState(asleep, ["PLAT-2"], map, at).unblockedAt).toBeNull();
  });

  test("a woken issue stays woken across syncs; a reopened blocker clears it", () => {
    const woken: WakeState = {
      openBlockers: [],
      unblockedAt: at,
      unblockedBy: "PLAT-1",
      unblockNotifiedAt: "2026-10-02T14:00:00.000Z",
    };
    expect(nextWakeState(woken, [], map, "2026-10-03T09:00:00.000Z")).toEqual(woken);
    expect(nextWakeState(woken, ["PLAT-1"], map, "2026-10-03T09:00:00.000Z")).toEqual({
      openBlockers: ["PLAT-1"],
      unblockedAt: null,
      unblockedBy: null,
      unblockNotifiedAt: null,
    });
  });

  test("the reason says which blocker moved where and when", () => {
    expect(unblockReason("PLAT-1", map)).toBe("PLAT-1 moved to Done on 2 Oct");
    expect(unblockReason("PLAT-9", map)).toBe("PLAT-9 no longer blocks it");
    expect(unblockReason(null, map)).toBe("Its blockers are done");
  });

  test("woken tickets: open, within seven days, not viewed since, not snoozed; newest first", () => {
    const now = new Date("2026-10-03T09:00:00.000Z");
    const row = (key: string, patch: Partial<WokenRow> = {}): WokenRow => ({
      key,
      summary: `Ticket ${key}`,
      statusCategory: "indeterminate",
      unblockedAt: "2026-10-02T13:00:00.000Z",
      unblockedBy: "PLAT-1",
      unblockNotifiedAt: null,
      lastViewedAt: null,
      snoozedUntil: null,
      ...patch,
    });
    const list = wokenTickets(
      [
        row("PAY-1"),
        row("PAY-2", { unblockedAt: "2026-10-03T08:00:00.000Z", unblockNotifiedAt: at }),
        row("PAY-3", { statusCategory: "done" }),
        row("PAY-4", { unblockedAt: "2026-09-25T08:00:00.000Z" }),
        row("PAY-5", { lastViewedAt: "2026-10-02T15:00:00.000Z" }),
        row("PAY-6", { lastViewedAt: "2026-10-01T15:00:00.000Z" }),
        row("PAY-7", { snoozedUntil: "2026-10-04T00:00:00.000Z" }),
        row("PAY-8", { unblockedAt: null }),
      ],
      map,
      now,
    );
    expect(list.map((t) => [t.key, t.notified])).toEqual([
      ["PAY-2", true],
      ["PAY-1", false],
      ["PAY-6", false],
    ]);
    expect(list[1]?.reason).toBe("PLAT-1 moved to Done on 2 Oct");
  });
});

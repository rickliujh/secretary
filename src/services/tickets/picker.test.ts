import { describe, expect, test } from "bun:test";
import { groupForPicker, type PickerTicket } from "./picker";

const NOW = "2026-09-26T12:00:00.000Z";
const t = (key: string, p: Partial<PickerTicket> = {}): PickerTicket => ({
  key,
  summary: key,
  status: "In Progress",
  statusCategory: "indeterminate",
  priority: "Medium",
  assignee: "me",
  assigneeDisplay: "Me",
  updated: "2026-09-20T00:00:00.000Z",
  lastViewedAt: null,
  blockedBy: [],
  ...p,
});

const shape = (groups: ReturnType<typeof groupForPicker>) =>
  groups.map((g) => [g.id, g.items.map((i) => i.ticket.key)]);

describe("groupForPicker", () => {
  const tickets = [
    t("LOW-1", { priority: "Low", updated: "2026-09-25T00:00:00.000Z" }),
    t("HIGH-1", { priority: "High" }),
    t("DONE-1", { statusCategory: "done", status: "Done" }),
    t("SEEN-1", { lastViewedAt: "2026-09-26T10:00:00.000Z" }),
    t("SEEN-OLD", { lastViewedAt: "2026-08-01T00:00:00.000Z", priority: "Lowest" }),
    t("BLK-1", { blockedBy: ["OPS-7"], priority: "Low" }),
    t("HOLD-1", { status: "On Hold", priority: "Highest" }),
    t("FOC-1", { priority: "Lowest" }),
    t("ANA-1", { assignee: "ana", assigneeDisplay: "Ana" }),
    t("ANA-DONE", { assignee: "ana", statusCategory: "done", status: "Done" }),
  ];

  test("recent, then focus, then blocked, then the rest by priority; done last", () => {
    const groups = groupForPicker({ tickets, focus: ["FOC-1", "SEEN-1"] }, null, NOW);
    expect(shape(groups)).toEqual([
      ["recent", ["SEEN-1"]],
      ["focus", ["FOC-1"]],
      ["blocked", ["HOLD-1", "BLK-1"]],
      ["open", ["HIGH-1", "ANA-1", "LOW-1", "SEEN-OLD"]],
      ["done", ["DONE-1", "ANA-DONE"]],
    ]);
    expect(groups.find((g) => g.id === "blocked")?.items.map((i) => i.note)).toEqual([
      "On Hold",
      "Blocked by OPS-7",
    ]);
  });

  test("the recipient's open tickets come first", () => {
    const groups = groupForPicker(
      { tickets, focus: [] },
      { label: "Ana", usernames: ["ana"] },
      NOW,
    );
    expect(groups[0]).toMatchObject({ id: "recipient", label: "Assigned to Ana" });
    expect(groups[0]?.items.map((i) => i.ticket.key)).toEqual(["ANA-1"]);
    expect(groups.flatMap((g) => g.items).filter((i) => i.ticket.key === "ANA-1")).toHaveLength(1);
  });
});

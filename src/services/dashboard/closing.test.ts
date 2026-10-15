import { describe, expect, test } from "bun:test";
import type { Transition } from "@/services/jira/schemas";
import {
  alreadyCommented,
  doneTransitions,
  dropComment,
  dropTransition,
  snoozeDay,
  snoozeUntil,
  validSnoozeDay,
} from "./closing";

const t = (id: string, to: string, category?: string, name = to): Transition => ({
  id,
  name,
  to: { name: to, ...(category ? { statusCategory: { key: category } } : {}) },
});

describe("which transition finishes or drops a ticket", () => {
  const workflow = [
    t("11", "In Progress", "indeterminate"),
    t("21", "Done", "done"),
    t("31", "Released", "done"),
    t("41", "Won't Do", "done"),
  ];

  test("Done offers every done-category status except cancel-like ones", () => {
    expect(doneTransitions(workflow).map((x) => x.to.name)).toEqual(["Done", "Released"]);
    expect(doneTransitions([t("5", "Closed", "done", "Cancel issue")])).toEqual([]);
  });

  test("without a category, the status name decides", () => {
    expect(doneTransitions([t("1", "Closed"), t("2", "Review")]).map((x) => x.id)).toEqual(["1"]);
  });

  test("drop takes a cancel-like status first, else the first done one, else none (D43)", () => {
    expect(dropTransition(workflow)?.to.name).toBe("Won't Do");
    expect(dropTransition(workflow.slice(0, 3))?.to.name).toBe("Done");
    expect(dropTransition([t("11", "In Progress", "indeterminate")])).toBeNull();
  });

  test("a cancel-like transition that does not close the ticket is never the drop", () => {
    const reopen = [t("5", "In Progress", "indeterminate", "Reject"), t("21", "Done", "done")];
    expect(dropTransition(reopen)?.to.name).toBe("Done");
    expect(dropTransition([t("6", "Rejected", "indeterminate")])).toBeNull();
    // Without a category Jira does not say, so the cancel-like name is trusted.
    expect(dropTransition([t("7", "Cancelled"), t("21", "Done", "done")])?.to.name).toBe(
      "Cancelled",
    );
    expect(dropTransition([t("8", "Closed", "done", "Reject"), t("21", "Done", "done")])?.id).toBe(
      "8",
    );
  });

  test("a retried drop skips the comment only when the user's newest one is the same", () => {
    const c = (who: string, body: string, created: string) => ({
      author: { id: who },
      body,
      created,
    });
    const body = "Closed without being done: not needed";
    const mine = [
      c("me", "earlier", "2026-10-01T09:00:00.000+0000"),
      c("me", body, "2026-10-07T09:00:00.000+0000"),
    ];
    expect(alreadyCommented(mine, "me", body)).toBe(true);
    expect(
      alreadyCommented([...mine, c("ana", "ok", "2026-10-07T10:00:00.000+0000")], "me", body),
    ).toBe(true);
    expect(
      alreadyCommented([...mine, c("me", "later", "2026-10-07T10:00:00.000+0000")], "me", body),
    ).toBe(false);
    expect(alreadyCommented([c("ana", body, "2026-10-07T09:00:00.000+0000")], "me", body)).toBe(
      false,
    );
    expect(alreadyCommented(mine, null, body)).toBe(false);
  });

  test("the comment says why, and that the work was not done when closed as done", () => {
    expect(dropComment(" not needed any more ", true)).toBe("Dropped: not needed any more");
    expect(dropComment("duplicate of PAY-9", false)).toBe(
      "Closed without being done: duplicate of PAY-9",
    );
  });
});

describe("snooze presets", () => {
  // Wednesday 7 October 2026.
  const WED = "2026-10-07";

  test("tomorrow is the next working day; Monday the next Monday", () => {
    expect(snoozeDay("tomorrow", WED, null)).toBe("2026-10-08");
    expect(snoozeDay("tomorrow", "2026-10-09", null)).toBe("2026-10-12");
    expect(snoozeDay("monday", WED, null)).toBe("2026-10-12");
    expect(snoozeDay("monday", "2026-10-11", null)).toBe("2026-10-12");
    expect(snoozeDay("monday", "2026-10-12", null)).toBe("2026-10-19");
  });

  test("after the sprint is the first working day after its end; none without a running sprint", () => {
    expect(snoozeDay("sprint", WED, "2026-10-09")).toBe("2026-10-12");
    expect(snoozeDay("sprint", WED, "2026-10-07")).toBe("2026-10-08");
    expect(snoozeDay("sprint", WED, "2026-10-06")).toBeNull();
    expect(snoozeDay("sprint", WED, null)).toBeNull();
  });

  test("a picked day must be after today", () => {
    expect(validSnoozeDay("2026-10-08", WED)).toBe(true);
    expect(validSnoozeDay(WED, WED)).toBe(false);
    expect(validSnoozeDay("2026-13-01", WED)).toBe(false);
  });

  test("a snooze ends at local midnight", () => {
    expect(new Date(snoozeUntil("2026-10-08")).getHours()).toBe(0);
  });
});

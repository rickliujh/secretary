import { describe, expect, test } from "bun:test";
import { isRevokeStatus, revokeStatus, revokeTransition } from "./cancel";

const t = (id: string, to: string, category = "indeterminate") => ({
  id,
  name: `to ${to}`,
  to: { name: to, statusCategory: { key: category } },
});

describe("revokeTransition (D54)", () => {
  test("a cancel-type status first, in the user's order", () => {
    const done = t("1", "Done", "done");
    expect(
      revokeTransition([done, t("2", "Declined", "done"), t("3", "Won't Do", "done")])?.id,
    ).toBe("3");
    expect(
      revokeTransition([done, t("4", "Rejected", "done"), t("5", "Canceled", "done")])?.id,
    ).toBe("5");
    expect(revokeTransition([t("6", "Cancelled", "done"), t("7", "Won't do", "done")])?.id).toBe(
      "6",
    );
    expect(revokeTransition([done, t("8", "Declined", "done")])?.id).toBe("8");
    // Named like a cancel status, whatever its category.
    expect(revokeTransition([done, t("9", "Rejected")])?.id).toBe("9");
  });

  test("else any done status, else none", () => {
    expect(revokeTransition([t("1", "In Progress"), t("2", "Closed", "done")])?.id).toBe("2");
    expect(revokeTransition([t("1", "In Progress"), t("2", "In Review")])).toBeNull();
    expect(revokeTransition([])).toBeNull();
  });

  test("isRevokeStatus", () => {
    expect(
      ["Cancelled", "Canceled", "Won't Do", "Wont do", "Rejected", "Declined"].map(isRevokeStatus),
    ).toEqual([true, true, true, true, true, true]);
    expect(["Done", "Closed", "Duplicate", "Cancellation review"].map(isRevokeStatus)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  test("revokeStatus picks among statuses the same way, for a status not reached yet", () => {
    const st = (name: string, category = "indeterminate") => ({ name, category });
    expect(
      revokeStatus([st("To Do", "new"), st("Done", "done"), st("Won't Do", "done")])?.name,
    ).toBe("Won't Do");
    expect(revokeStatus([st("To Do", "new"), st("Closed", "done")])?.name).toBe("Closed");
    expect(revokeStatus([st("To Do", "new"), st("In Progress")])).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import { createRevokeText, type RevokedTicket, revokedTicket } from "@/services/proposals/revoke";
import { threadOutcomes } from "./decided";

const create = {
  kind: "create_issue",
  ref: "$new:1",
  projectKey: "PAY",
  issueType: "Task",
  summary: "Send Dana the Q3 numbers",
  labels: ["small-ask"],
  assignee: "me",
  smallAsk: true,
};
const comment = { kind: "add_comment", target: "$new:1", bodyMd: "Asked finance." };
const wait = {
  kind: "link_dependency",
  target: "$new:1",
  dependencyKind: "team",
  label: "Finance export",
};
const update = { kind: "update_issue", target: "PAY-2", changes: { assignee: "ana.b" } };
const row = (payload: { kind: string }, status: string, result: unknown = null) => ({
  kind: payload.kind,
  status,
  payload,
  editedPayload: null,
  result,
});
/** A revoked result; `record` adds the fields kept from FR-14.6 on. */
const revoked = (
  message: string,
  extra: Record<string, unknown> = {},
  record: Record<string, unknown> = {},
) => ({
  ...extra,
  revoked: { at: "2026-10-15T10:00:00.000Z", message, ...record },
});
const ticket = (t: RevokedTicket) => ({ ticket: t });

describe("revokedTicket (FR-14.6)", () => {
  test("the record's ticket when it has one, whatever the message says", () => {
    const t: RevokedTicket = { key: "PAY-41", state: "deleted" };
    expect(revokedTicket("PAY-41", { message: "Nothing was left to undo.", ticket: t })).toEqual(t);
  });

  test("older records: read back from the message", () => {
    expect(revokedTicket("PAY-41", { message: createRevokeText.deleted("PAY-41") })).toEqual({
      key: "PAY-41",
      state: "deleted",
    });
    expect(
      revokedTicket("PAY-41", { message: createRevokeText.alreadyDeleted("PAY-41") }).state,
    ).toBe("deleted");
    expect(
      revokedTicket("PAY-41", {
        message: `Commented on PAY-41; ${createRevokeText.moved("PAY-41", "Won't Do")}`,
      }),
    ).toEqual({ key: "PAY-41", state: "closed", status: "Won't Do", moved: true });
    expect(revokedTicket("PAY-41", { message: "Commented on PAY-41" })).toEqual({
      key: "PAY-41",
      state: "closed",
      status: null,
      moved: false,
    });
    // Another ticket's delete in the message is not this one's.
    expect(revokedTicket("PAY-4", { message: "Deleted PAY-41" }).state).toBe("closed");
  });
});

describe("threadOutcomes", () => {
  test("a revoked create whose ticket was deleted: revoked, not a candidate, its refs resolved", () => {
    const r = threadOutcomes([
      row(
        create,
        "revoked",
        revoked(
          "Deleted PAY-41",
          { issueKey: "PAY-41" },
          ticket({ key: "PAY-41", state: "deleted" }),
        ),
      ),
      row(comment, "revoked", revoked("Deleted the comment on PAY-41", { undo: {} })),
      row(wait, "rejected", {
        dismissed: true,
        reason: "The ticket it acts on was revoked.",
      }),
    ]);
    expect(r.decided).toEqual([
      {
        outcome: "revoked",
        description: "Create Task in PAY: Send Dana the Q3 numbers",
        undone: "PAY-41 was deleted and no longer exists",
      },
      {
        outcome: "revoked",
        description: "Comment on PAY-41",
        undone: "Deleted the comment on PAY-41",
      },
      {
        outcome: "dropped",
        description: "PAY-41 waits on Finance export",
        reason: "The ticket it acts on was revoked.",
      },
    ]);
    expect(r.deletedKeys).toEqual(["PAY-41"]);
    expect(r.createdKeys).toEqual([]);
  });

  test("deleted outside Secretary first: the stored ticket says deleted", () => {
    const r = threadOutcomes([
      row(
        create,
        "revoked",
        revoked(
          createRevokeText.alreadyDeleted("PAY-41"),
          { issueKey: "PAY-41" },
          { ...ticket({ key: "PAY-41", state: "deleted" }), unchanged: true },
        ),
      ),
    ]);
    expect(r.decided[0]?.undone).toBe("PAY-41 was deleted and no longer exists");
    expect(r.deletedKeys).toEqual(["PAY-41"]);
  });

  test("a revoked create whose ticket was closed stays a candidate", () => {
    const moved = threadOutcomes([
      row(
        create,
        "revoked",
        revoked(
          "Commented on PAY-41; Moved PAY-41 to Cancelled",
          { issueKey: "PAY-41" },
          ticket({ key: "PAY-41", state: "closed", status: "Cancelled", moved: true }),
        ),
      ),
    ]);
    expect(moved.decided[0]?.undone).toBe("PAY-41 was closed and moved to Cancelled");
    expect(moved.createdKeys).toEqual(["PAY-41"]);
    expect(moved.deletedKeys).toEqual([]);
    // Closed before the revoke: it is closed, as the cache shows it now.
    const already = threadOutcomes(
      [
        row(
          create,
          "revoked",
          revoked(
            "Commented on PAY-41",
            { issueKey: "PAY-41" },
            ticket({ key: "PAY-41", state: "closed", status: "Done", moved: false }),
          ),
        ),
      ],
      (key) => (key === "PAY-41" ? "Done" : null),
    );
    expect(already.decided[0]?.undone).toBe("PAY-41 is closed (Done)");
  });

  test("older records without a ticket are read from their message", () => {
    const deleted = threadOutcomes([
      row(create, "revoked", revoked("Deleted PAY-41", { issueKey: "PAY-41" })),
    ]);
    expect(deleted.deletedKeys).toEqual(["PAY-41"]);
    const moved = threadOutcomes([
      row(
        create,
        "revoked",
        revoked("Commented on PAY-41; Moved PAY-41 to Cancelled", { issueKey: "PAY-41" }),
      ),
    ]);
    expect(moved.decided[0]?.undone).toBe("PAY-41 was closed and moved to Cancelled");
    const already = threadOutcomes(
      [
        row(
          create,
          "revoked",
          revoked("You may not delete issues there, so PAY-41 is closed instead.", {
            issueKey: "PAY-41",
          }),
        ),
      ],
      () => "Done",
    );
    expect(already.decided[0]?.undone).toBe("PAY-41 is closed (Done)");
  });

  test("a revoke that changed nothing back says so, with what was left", () => {
    const r = threadOutcomes([
      row(
        update,
        "revoked",
        revoked(
          "PAY-2 already has its earlier values.",
          {},
          {
            unchanged: true,
            warning: "Jira refused to assign PAY-2 back to Tom Kay (no permission).",
          },
        ),
      ),
      // An older record: only its message says nothing was left.
      row(comment, "revoked", revoked("Nothing was left to undo.")),
    ]);
    expect(r.decided).toEqual([
      {
        outcome: "revoked",
        description: "Update PAY-2: assignee",
        undone: "PAY-2 already has its earlier values.",
        unchanged: true,
        kept: "Jira refused to assign PAY-2 back to Tom Kay (no permission).",
      },
      {
        outcome: "revoked",
        description: "Comment on $new:1",
        undone: "Nothing was left to undo.",
        unchanged: true,
      },
    ]);
  });

  test("approvals and the user's rejections read as before", () => {
    const r = threadOutcomes([
      row(create, "executed", { issueKey: "PAY-41", message: "Created PAY-41" }),
      row(comment, "rejected"),
      row(wait, "failed", { error: "boom" }),
      row({ kind: "needs_clarification" }, "executed"),
      row(comment, "pending"),
      row(comment, "superseded"),
      // Dismissing the thread is the user's own decision.
      row(comment, "rejected", { dismissed: true }),
    ]);
    expect(r.decided).toEqual([
      { outcome: "done", description: "Create Task in PAY: Send Dana the Q3 numbers" },
      { outcome: "rejected", description: "Comment on PAY-41" },
      { outcome: "done", description: "PAY-41 waits on Finance export" },
      { outcome: "rejected", description: "Comment on PAY-41" },
    ]);
    expect(r.createdKeys).toEqual(["PAY-41"]);
  });
});

import { describe, expect, test } from "bun:test";
import { buildRecapFacts, type RecapInputs, type RecapIssue, reportWindow } from "./facts";

const SINCE = "2026-09-24T00:00:00.000Z";
const i = (key: string, p: Partial<RecapIssue> = {}): RecapIssue => ({
  key,
  summary: key,
  issueType: "Story",
  isSubtask: false,
  status: "In Progress",
  statusCategory: "indeterminate",
  assignee: "me",
  reporter: "tom",
  reporterDisplay: "Tom",
  epicKey: null,
  sprint: "PAY 15",
  storyPoints: null,
  dueDate: null,
  created: "2026-09-01T00:00:00.000Z",
  updated: "2026-09-20T00:00:00.000Z",
  resolved: null,
  blockedBy: [],
  ...p,
});

const inputs = (p: Partial<RecapInputs> = {}): RecapInputs => ({
  me: "me",
  since: SINCE,
  until: "2026-09-26T09:00:00.000Z",
  tracked: new Set(),
  activeSprints: new Set(["PAY 15"]),
  focus: [],
  issues: [],
  comments: [],
  history: new Map(),
  ...p,
});

const groups = (f: ReturnType<typeof buildRecapFacts>) =>
  Object.fromEntries(
    ["done", "new", "blocked", "in_progress", "changed", "next"].map((g) => [
      g,
      f.tickets.filter((t) => t.group === g).map((t) => t.key),
    ]),
  );

describe("buildRecapFacts", () => {
  test("groups my work: done, new, blocked, in progress, changed, next", () => {
    const f = buildRecapFacts(
      inputs({
        focus: ["TODO-2", "TODO-1"],
        issues: [
          i("DONE-1", {
            statusCategory: "done",
            status: "Done",
            resolved: "2026-09-25T10:00:00.000Z",
            storyPoints: 5,
          }),
          i("DONE-OLD", {
            statusCategory: "done",
            status: "Done",
            resolved: "2026-09-10T00:00:00.000Z",
          }),
          i("NEW-1", {
            statusCategory: "new",
            status: "To Do",
            created: "2026-09-25T08:00:00.000Z",
          }),
          i("ASSIGNED-1", { statusCategory: "new", status: "To Do" }),
          i("BLK-1", { blockedBy: ["OPS-7"] }),
          i("WIP-1", { updated: "2026-09-25T00:00:00.000Z" }),
          i("WIP-2"),
          i("OTHER-1", { assignee: "ana", reporter: "me" }),
          i("OTHER-QUIET", { assignee: "ana", reporter: "me" }),
          i("TODO-1", { statusCategory: "new", status: "To Do" }),
          i("TODO-2", { statusCategory: "new", status: "To Do" }),
          i("BACKLOG-1", { statusCategory: "new", status: "To Do", sprint: null }),
          i("NOT-MINE", { assignee: "ana" }),
          i("EP-1", { issueType: "Epic" }),
        ],
        comments: [
          {
            issueKey: "OTHER-1",
            author: "ana",
            authorDisplay: "Ana",
            created: "2026-09-25T09:00:00.000Z",
            body: "Deployed to staging.",
          },
          {
            issueKey: "WIP-1",
            author: "me",
            authorDisplay: "Me",
            created: "2026-09-25T09:00:00.000Z",
            body: "Started.",
          },
          {
            issueKey: "NOT-MINE",
            author: "ana",
            authorDisplay: "Ana",
            created: "2026-09-25T09:00:00.000Z",
            body: "x",
          },
        ],
        history: new Map([
          [
            "ASSIGNED-1",
            [
              {
                at: "2026-09-24T15:00:00.000Z",
                author: "tom",
                authorDisplay: "Tom",
                items: [{ field: "assignee", from: null, to: "Me", toId: "me" }],
              },
            ],
          ],
          [
            "WIP-1",
            [
              {
                at: "2026-09-25T08:00:00.000Z",
                author: "me",
                authorDisplay: "Me",
                items: [{ field: "status", from: "To Do", to: "In Progress", toId: "3" }],
              },
            ],
          ],
        ]),
      }),
    );
    expect(groups(f)).toEqual({
      done: ["DONE-1"],
      new: ["NEW-1", "ASSIGNED-1"],
      blocked: ["BLK-1"],
      in_progress: ["WIP-1", "WIP-2"],
      changed: ["OTHER-1"],
      next: ["TODO-2", "TODO-1"],
    });
    const note = (k: string) => f.tickets.find((t) => t.key === k)?.notes;
    expect(note("WIP-1")).toEqual(["To Do -> In Progress (you, 25 Sep)", "You commented"]);
    expect(note("ASSIGNED-1")).toEqual(["Assigned to you (by Tom, 24 Sep)"]);
    expect(note("NEW-1")).toEqual(["Created 25 Sep by Tom"]);
    expect(f.tickets.find((t) => t.key === "OTHER-1")?.quote).toBe("Deployed to staging.");
    expect(f.stats).toEqual({ done: 1, pointsDone: 5, inProgress: 2, new: 2, comments: 2 });
  });

  test("tracked epics bring their tickets in", () => {
    const f = buildRecapFacts(
      inputs({
        tracked: new Set(["EP-9"]),
        issues: [
          i("T-1", {
            assignee: "ana",
            epicKey: "EP-9",
            statusCategory: "done",
            status: "Done",
            resolved: "2026-09-25T00:00:00.000Z",
          }),
        ],
      }),
    );
    expect(groups(f).done).toEqual(["T-1"]);
  });
});

describe("reportWindow", () => {
  test("last working day skips the weekend", () => {
    const monday = new Date(2026, 8, 28, 9, 0);
    const w = reportWindow({ kind: "workday" }, monday);
    expect(new Date(w.since)).toEqual(new Date(2026, 8, 25, 0, 0));
    expect(w.label).toBe("Since Friday");
    const thursday = new Date(2026, 8, 24, 9, 0);
    expect(reportWindow({ kind: "workday" }, thursday).label).toBe("Since yesterday");
  });

  test("days count back from local midnight", () => {
    const now = new Date(2026, 8, 24, 15, 0);
    const w = reportWindow({ kind: "days", days: 7 }, now);
    expect(new Date(w.since)).toEqual(new Date(2026, 8, 17, 0, 0));
    expect(w.label).toBe("Last 7 days");
  });
});

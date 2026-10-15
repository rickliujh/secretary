import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { syncedJiraLayer, syncOnce } from "@/test/seed";
import { json } from "@/test/stub-fetch";
import { checkHome, smallAskHome, syncedProjectKeys } from "./queries";

const types = [
  { id: "1", name: "Epic", subtask: false },
  { id: "2", name: "Task", subtask: false },
  { id: "3", name: "Bug", subtask: false },
  { id: "4", name: "Sub-task", subtask: true },
  // A sub-task type by Jira's flag, whatever its name.
  { id: "5", name: "Action", subtask: true },
];
const base = [
  { fieldId: "project", name: "Project", required: true },
  { fieldId: "issuetype", name: "Issue Type", required: true },
  { fieldId: "summary", name: "Summary", required: true },
  { fieldId: "assignee", name: "Assignee", required: false },
];
const createMeta = {
  match: (u: URL) => u.pathname.includes("/issue/createmeta/ASK/issuetypes"),
  respond: (r: { url: URL }) => {
    const id = /issuetypes\/(\w+)$/.exec(r.url.pathname)?.[1];
    if (!id) return json({ values: types });
    // Tasks have labels; bugs need a component and have no labels field.
    return json({
      values:
        id === "2"
          ? [
              ...base,
              { fieldId: "labels", name: "Labels", required: false },
              { fieldId: "duedate", name: "Due Date", required: true },
            ]
          : [...base, { fieldId: "components", name: "Component/s", required: true }],
    });
  },
};

describe("small-asks home (FR-10.1)", () => {
  test("sync reads the home's metadata even with none of its issues cached", async () => {
    const { layer } = syncedJiraLayer([], {
      smallAsks: {
        projectKey: "ASK",
        label: "small-ask",
        joinActiveSprint: true,
        hintDismissed: false,
        defaultPoints: null,
      },
    });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* syncOnce;
          return { home: yield* smallAskHome, projects: yield* syncedProjectKeys };
        }),
        layer,
      ),
    );
    expect(r.projects).toEqual(["ASK", "OPS", "PAY"]);
    // The fixture project ASK offers Task and Sub-task.
    expect(r.home.home).toEqual({
      projectKey: "ASK",
      label: "small-ask",
      joinActiveSprint: true,
      issueTypes: ["Task"],
      defaultType: "Task",
      subtaskTypes: ["Sub-task"],
    });
  });

  test("no home: null, and the hint state", async () => {
    const { layer } = syncedJiraLayer();
    const r = await Effect.runPromise(Effect.provide(smallAskHome, layer));
    expect(r).toEqual({ home: null, hintDismissed: false });
  });

  test("the check lists the types, the fields the app cannot fill, and those it fills only sometimes", async () => {
    const { layer } = syncedJiraLayer([createMeta]);
    const r = await Effect.runPromise(Effect.provide(checkHome("ASK"), layer));
    expect(r).toEqual({
      projectKey: "ASK",
      issueTypes: ["Task", "Bug"],
      defaultType: "Task",
      blocked: [{ issueType: "Bug", fields: ["Component/s"] }],
      needed: [{ issueType: "Task", fields: ["Due Date"] }],
      notOnScreen: [
        { issueType: "Task", fields: ["Description"] },
        { issueType: "Bug", fields: ["Labels", "Description"] },
      ],
    });
  });
});

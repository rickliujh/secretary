import { describe, expect, test } from "bun:test";
import {
  askedByLine,
  checkCreateFields,
  defaultSmallAskType,
  isSubtaskType,
  knownSubtaskTypes,
  literalWiki,
  provenanceDate,
  smallAskTypes,
  splitProvenance,
  stripProvenance,
  withProvenance,
} from "./home";

describe("small-ask issue types (D44)", () => {
  test("no epics and no sub-tasks; Task by default, else the first standard type", () => {
    expect(smallAskTypes(["Epic", "Story", "Task", "Sub-task", "Bug"])).toEqual([
      "Story",
      "Task",
      "Bug",
    ]);
    expect(defaultSmallAskType(["Epic", "Story", "Task", "Bug"])).toBe("Task");
    expect(defaultSmallAskType(["Epic", "Story", "Bug", "Subtask"])).toBe("Story");
    expect(defaultSmallAskType(["Epic", "Sub-task"])).toBeNull();
  });

  test("Jira's sub-task flag decides when it is known; the name only without it", () => {
    const types = ["Epic", "Action", "Task", "Subtask review"];
    // "Action" is a sub-task type; "Subtask review" is a standard one.
    expect(smallAskTypes(types, ["Action"])).toEqual(["Task", "Subtask review"]);
    expect(defaultSmallAskType(["Action", "Story"], ["Action"])).toBe("Story");
    expect(isSubtaskType("Action", ["Action"])).toBe(true);
    expect(isSubtaskType("Sub-task", [])).toBe(false);
    // Metadata stored before the flag was kept: names decide.
    expect(smallAskTypes(types)).toEqual(["Action", "Task"]);
    expect(knownSubtaskTypes({ A: { subtaskTypes: ["Action"] }, B: { subtaskTypes: [] } })).toEqual(
      ["Action"],
    );
    expect(knownSubtaskTypes({ A: { subtaskTypes: ["Action"] }, B: {} })).toBeNull();
  });
});

describe("checkCreateFields", () => {
  test("lists required fields without a default that the app does not fill", () => {
    const fields = [
      { fieldId: "project", name: "Project", required: true },
      { fieldId: "summary", name: "Summary", required: true },
      { fieldId: "labels", name: "Labels", required: true },
      { fieldId: "components", name: "Component/s", required: true },
      { fieldId: "priority", name: "Priority", required: true, hasDefaultValue: true },
      { fieldId: "customfield_1", name: "Team", required: true },
      { fieldId: "customfield_2", name: "Notes", required: false },
      { fieldId: "customfield_10100", name: "Epic Link", required: true },
    ];
    const c = checkCreateFields(fields, "customfield_10100");
    expect(c.unfillable).toEqual(["Component/s", "Team"]);
    // Labels are on the screen; assignee and description are not.
    expect(c.notOnScreen).toEqual(["Assignee", "Description"]);
  });

  test("fields filled only when the model gives a value are needed on every ask", () => {
    const fields = [
      { fieldId: "duedate", name: "Due Date", required: true },
      { fieldId: "priority", name: "Priority", required: true },
      { fieldId: "parent", name: "Parent", required: true },
      { fieldId: "customfield_10100", name: "Epic Link", required: true },
      { fieldId: "description", name: "Description", required: true },
      { fieldId: "assignee", name: "Assignee", required: true },
      { fieldId: "labels", name: "Labels", required: true },
    ];
    expect(checkCreateFields(fields, "customfield_10100")).toEqual({
      unfillable: [],
      whenGiven: ["Due Date", "Priority", "Parent", "Epic Link"],
      notOnScreen: [],
    });
    // Without a known Epic Link field it is one the app cannot fill.
    expect(checkCreateFields(fields).unfillable).toEqual(["Epic Link"]);
  });
});

describe("provenance (FR-10.4)", () => {
  const p = {
    requester: "Dana Reyes",
    source: "teams",
    date: "2026-09-24",
    quote: "can you send me the Q3 numbers\nby Friday?",
  };

  test("names who asked, how and when, and quotes the words", () => {
    expect(askedByLine(p)).toBe("Asked by Dana Reyes via Teams on 2026-09-24");
    expect(askedByLine({ ...p, requester: null, source: "email" })).toBe(
      "Asked via email on 2026-09-24",
    );
    expect(withProvenance("Send the Q3 numbers.", p)).toBe(
      "Send the Q3 numbers.\n\n_Asked by Dana Reyes via Teams on 2026-09-24:_\n\n> can you send me the Q3 numbers\n> by Friday?",
    );
    expect(withProvenance(null, { ...p, quote: "" })).toBe(
      "_Asked by Dana Reyes via Teams on 2026-09-24:_",
    );
  });

  test("is idempotent and can be taken off again", () => {
    const once = withProvenance("Send the numbers.", p);
    expect(withProvenance(once, p)).toBe(once);
    expect(stripProvenance(once)).toBe("Send the numbers.");
    expect(stripProvenance(withProvenance(null, p))).toBeNull();
    // A quote with a blank line still strips cleanly.
    const blank = withProvenance("Do it.", { ...p, quote: "first\n\nsecond" });
    expect(stripProvenance(blank)).toBe("Do it.");
    expect(stripProvenance("Plain text, no block.")).toBe("Plain text, no block.");
  });

  test("a made-up Asked by line anywhere in the model's text is removed", () => {
    const fake =
      "Send the numbers.\n\n_Asked by The CEO via email on 2026-01-01:_\n\nThen file them.\nAsked by Bob via Teams on 2026-02-02";
    expect(stripProvenance(fake)).toBe("Send the numbers.\n\nThen file them.");
    const real = withProvenance(fake, p);
    expect(real.match(/Asked by/g)).toHaveLength(1);
    expect(real).toContain("_Asked by Dana Reyes via Teams on 2026-09-24:_");
  });

  test("the block can be split off and its date read back", () => {
    const once = withProvenance("Send the numbers.", p);
    expect(splitProvenance(once)).toEqual({
      base: "Send the numbers.",
      line: "_Asked by Dana Reyes via Teams on 2026-09-24:_",
      date: "2026-09-24",
      quote: "can you send me the Q3 numbers\nby Friday?",
    });
    expect(provenanceDate(once)).toBe("2026-09-24");
    expect(provenanceDate("No block")).toBeNull();
  });

  test("literal wiki text cannot end its block early", () => {
    expect(literalWiki("a {noformat} b {NOFORMAT}")).toBe(
      "{noformat}\na { noformat} b { NOFORMAT}\n{noformat}",
    );
  });
});

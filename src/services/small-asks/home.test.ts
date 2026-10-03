import { describe, expect, test } from "bun:test";
import {
  askedByLine,
  defaultSmallAskType,
  smallAskTypes,
  stripProvenance,
  unfillableFields,
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
});

describe("unfillableFields", () => {
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
    expect(unfillableFields(fields, ["customfield_10100"])).toEqual(["Component/s", "Team"]);
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
});

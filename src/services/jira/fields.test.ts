import { describe, expect, test } from "bun:test";
import { pointsFieldForIssue, pointsFieldOn } from "./fields";

describe("pointsFieldOn (D55)", () => {
  // Cloud with both fields: "Story point estimate" first, then "Story Points".
  const ids = { storyPoints: "customfield_10016", storyPointsAlt: ["customfield_10026"] };

  test("the first effective story point field the screen has", () => {
    expect(pointsFieldOn(ids, ["summary", "customfield_10026", "customfield_10016"])).toBe(
      "customfield_10016",
    );
    expect(pointsFieldOn(ids, ["summary", "customfield_10026"])).toBe("customfield_10026");
  });

  test("create metadata (field ids) and edit metadata (its keys) both work", () => {
    const createMeta = [{ fieldId: "summary" }, { fieldId: "customfield_10026" }];
    const editMeta = { fields: { customfield_10016: {}, labels: {} } };
    expect(
      pointsFieldOn(
        ids,
        createMeta.map((f) => f.fieldId),
      ),
    ).toBe("customfield_10026");
    expect(pointsFieldOn(ids, Object.keys(editMeta.fields))).toBe("customfield_10016");
  });

  test("null when the screen has none, or no story point field is known", () => {
    expect(pointsFieldOn(ids, ["summary", "labels"])).toBeNull();
    expect(pointsFieldOn({}, ["customfield_10016"])).toBeNull();
  });

  test("an existing issue: both on screen, the write goes where its points are", () => {
    const screen = ["customfield_10016", "customfield_10026"];
    // Estimated in "Story Points": the board reads that one, so it is written there.
    expect(
      pointsFieldForIssue(ids, screen, { customfield_10016: null, customfield_10026: 3 }),
    ).toBe("customfield_10026");
    expect(pointsFieldForIssue(ids, screen, { customfield_10016: 2, customfield_10026: 3 })).toBe(
      "customfield_10016",
    );
    // Unestimated: the first on the screen; a field holding points off the screen does not count.
    expect(pointsFieldForIssue(ids, screen, {})).toBe("customfield_10016");
    expect(pointsFieldForIssue(ids, ["customfield_10016"], { customfield_10026: 3 })).toBe(
      "customfield_10016",
    );
    expect(pointsFieldForIssue(ids, ["summary"], { customfield_10026: 3 })).toBeNull();
  });

  test("a field set by hand replaces the discovered ones", () => {
    expect(pointsFieldOn({ storyPoints: "customfield_10100" }, ["customfield_10100"])).toBe(
      "customfield_10100",
    );
  });
});

import { describe, expect, test } from "bun:test";
import { buildScopeJql, chunk, stripOrderBy, withUpdatedSince } from "./jql";

describe("scope JQL", () => {
  test("combines user JQL with tracked epics and their children", () => {
    expect(
      buildScopeJql({
        userJql: "assignee = currentUser() ORDER BY priority DESC",
        trackedEpics: ["PAY-1", "OPS-2"],
        epicLinkFieldId: "customfield_10100",
      }),
    ).toBe(
      "(assignee = currentUser()) OR key in (PAY-1, OPS-2) OR cf[10100] in (PAY-1, OPS-2) OR parent in (PAY-1, OPS-2)",
    );
  });

  test("ignores malformed epic keys and works without an Epic Link field", () => {
    expect(buildScopeJql({ userJql: "", trackedEpics: ["pay-1", "PAY-9"] })).toBe(
      "key in (PAY-9) OR parent in (PAY-9)",
    );
  });

  test("an empty scope is an error", () => {
    expect(() => buildScopeJql({ userJql: "  ", trackedEpics: [] })).toThrow();
  });

  test("strips ORDER BY in any case", () => {
    expect(stripOrderBy("project = PAY order by rank")).toBe("project = PAY");
  });
});

describe("incremental clause", () => {
  test("full sync orders by updated", () => {
    expect(withUpdatedSince("project = PAY", undefined)).toBe(
      "(project = PAY) ORDER BY updated ASC",
    );
  });

  test("watermark minus five minutes in the user's time zone", () => {
    expect(withUpdatedSince("project = PAY", "2026-09-21T15:40:12.000Z", "Europe/London")).toBe(
      '(project = PAY) AND updated >= "2026/09/21 16:35" ORDER BY updated ASC',
    );
  });

  test("chunk", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

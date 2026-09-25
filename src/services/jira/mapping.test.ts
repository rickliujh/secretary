import { describe, expect, test } from "bun:test";
import fields from "@/test/fixtures/jira/field.json";
import page1 from "@/test/fixtures/jira/search-page-1.json";
import page2 from "@/test/fixtures/jira/search-page-2.json";
import { jiraDateToIso, toJqlDate } from "./dates";
import { discoverFieldIds, effectiveFieldIds, jqlFieldRef } from "./fields";
import { currentSprint, issueFields, mapIssue, parseSprints } from "./mapping";
import { FieldSchema, SearchPageSchema } from "./schemas";

const fieldIds = discoverFieldIds(fields.map((f) => FieldSchema.parse(f)));
const ctx = { fieldIds, trackedEpics: new Set(["PAY-1"]), syncedAt: "2026-09-23T12:00:00.000Z" };
const issues = [...SearchPageSchema.parse(page1).issues, ...SearchPageSchema.parse(page2).issues];
const byKey = (key: string) => {
  const raw = issues.find((i) => i.key === key);
  if (!raw) throw new Error(key);
  return mapIssue(raw, ctx);
};

describe("field discovery", () => {
  test("finds Epic Link, Epic Name and Sprint by custom type", () => {
    expect(fieldIds).toEqual({
      epicLink: "customfield_10100",
      epicName: "customfield_10102",
      sprint: "customfield_10104",
    });
  });

  test("overrides win; blanks fall back to discovery", () => {
    expect(effectiveFieldIds(fieldIds, { epicLink: "customfield_1", epicName: " " })).toEqual({
      epicLink: "customfield_1",
      epicName: "customfield_10102",
      sprint: "customfield_10104",
    });
  });

  test("custom field ids become cf[] references", () => {
    expect(jqlFieldRef("customfield_10100")).toBe("cf[10100]");
    expect(jqlFieldRef("parent")).toBe("parent");
  });

  test("requested fields include discovered custom fields", () => {
    expect(issueFields(fieldIds)).toContain("customfield_10104");
  });
});

describe("dates", () => {
  test("Jira offsets without a colon parse to UTC ISO", () => {
    expect(jiraDateToIso("2026-09-21T16:40:12.000+0100")).toBe("2026-09-21T15:40:12.000Z");
    expect(jiraDateToIso("2026-01-05T08:00:00.000-0500")).toBe("2026-01-05T13:00:00.000Z");
  });

  test("JQL dates are formatted in the user's time zone", () => {
    expect(toJqlDate("2026-09-21T15:40:12.000Z", "Europe/London")).toBe("2026/09/21 16:40");
    expect(toJqlDate("2026-09-21T15:40:12.000Z", "UTC")).toBe("2026/09/21 15:40");
    expect(toJqlDate("2026-01-01T00:30:00.000Z", "America/New_York")).toBe("2025/12/31 19:30");
  });
});

describe("mapIssue", () => {
  test("epic: tracked flag, epic name, rendered description, no comments", () => {
    const { issue, comments, commentsComplete } = byKey("PAY-1");
    expect(issue).toMatchObject({
      issueType: "Epic",
      isTrackedEpic: true,
      epicName: "Billing migration",
      statusCategory: "indeterminate",
      priority: "High",
      assignee: "rliu",
      assigneeDisplay: "Rick Liu",
      labels: ["billing"],
      components: ["Invoicing"],
      dueDate: "2026-12-15",
      updated: "2026-09-20T09:15:00.000Z",
      resolved: null,
      epicKey: null,
    });
    expect(issue.descriptionHtml).toContain("<b>billing</b>");
    expect(comments).toEqual([]);
    expect(commentsComplete).toBe(true);
  });

  test("story: epic link, legacy sprint strings, embedded comments with rendered bodies", () => {
    const { issue, comments, commentsComplete } = byKey("PAY-2");
    expect(issue.epicKey).toBe("PAY-1");
    expect(issue.parentKey).toBeNull();
    expect(issue.sprint).toBe("Payments 15");
    expect(comments).toHaveLength(2);
    expect(comments[0]).toMatchObject({
      id: "50001",
      author: "ana.b",
      authorDisplay: "Ana Bell",
      bodyHtml: "<p>Raised <tt>INC0012345</tt> with platform.</p>",
      created: "2026-09-10T08:00:00.000Z",
    });
    expect(commentsComplete).toBe(false);
    // Comments are stored in their own table, not duplicated in raw.
    expect(issue.raw).not.toHaveProperty("comment");
    expect((issue.raw as Record<string, unknown>).issuelinks).toHaveLength(1);
  });

  test("sub-task: parent key, done category, nulls handled", () => {
    const { issue } = byKey("PAY-3");
    expect(issue).toMatchObject({
      isSubtask: true,
      parentKey: "PAY-2",
      epicKey: null,
      statusCategory: "done",
      priority: null,
      assignee: null,
      description: null,
      resolved: "2026-09-22T07:05:00.000Z",
    });
  });

  test("object-shaped sprint values are read too", () => {
    expect(byKey("OPS-7").issue.sprint).toBe("Ops 9");
    expect(
      currentSprint([
        { name: "Old", state: "closed" },
        { name: "Next", state: "future" },
      ]),
    ).toBe("Next");
    expect(currentSprint(null)).toBeNull();
  });

  test("parseSprints reads ids, boards and dates from both field shapes", () => {
    expect(
      parseSprints([
        "com.atlassian.greenhopper.service.sprint.Sprint@6b1c2e7[id=41,rapidViewId=7,state=CLOSED,name=Payments 14,startDate=2026-08-31T09:00:00.000+01:00,endDate=2026-09-14T17:00:00.000+01:00,completeDate=<null>,sequence=41,goal=]",
        {
          id: 50,
          name: "Q4 Sprint 2",
          state: "future",
          boardId: 12,
          startDate: "2026-10-12T08:00:00.000Z",
          endDate: "2026-10-26T08:00:00.000Z",
        },
        { id: 51, name: "Undated", state: "future", originBoardId: 12 },
      ]),
    ).toEqual([
      {
        id: 41,
        name: "Payments 14",
        state: "closed",
        boardId: 7,
        start: "2026-08-31",
        end: "2026-09-14",
      },
      {
        id: 50,
        name: "Q4 Sprint 2",
        state: "future",
        boardId: 12,
        start: "2026-10-12",
        end: "2026-10-26",
      },
      { id: 51, name: "Undated", state: "future", boardId: 12, start: null, end: null },
    ]);
  });

  test("a parent that is an Epic is treated as the epic link", () => {
    const raw = {
      id: "1",
      key: "NEW-2",
      fields: {
        summary: "s",
        issuetype: { name: "Story", subtask: false },
        status: { name: "To Do", statusCategory: { key: "new" } },
        parent: { key: "NEW-1", fields: { issuetype: { name: "Epic", subtask: false } } },
        created: "2026-09-01T09:00:00.000+0000",
        updated: "2026-09-01T09:00:00.000+0000",
      },
    };
    const { issue } = mapIssue(raw, ctx);
    expect(issue.epicKey).toBe("NEW-1");
    expect(issue.parentKey).toBeNull();
    expect(issue.projectKey).toBe("NEW");
  });
});

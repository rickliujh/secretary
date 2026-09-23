import { describe, expect, test } from "bun:test";
import { EditMetaSchema } from "@/services/jira";
import editmeta from "@/test/fixtures/jira/editmeta-PAY-2.json";
import { buildJiraWrite } from "./jira-mapping";

const fieldIds = {
  epicLink: "customfield_10100",
  epicName: "customfield_10102",
  sprint: "customfield_10104",
};
const meta = EditMetaSchema.parse(editmeta);

describe("buildJiraWrite", () => {
  test("comment bodies are converted from Markdown to wiki markup", () => {
    expect(
      buildJiraWrite(
        {
          kind: "add_comment",
          issueKey: "PAY-2",
          bodyMarkdown: "**Blocked** on `INC0012345`\n- chase Ana",
        },
        { fieldIds },
      ),
    ).toEqual({
      method: "POST",
      path: "issue/PAY-2/comment",
      body: { body: "*Blocked* on {{INC0012345}}\n* chase Ana" },
    });
  });

  test("transitions post the transition id", () => {
    expect(
      buildJiraWrite({ kind: "transition", issueKey: "PAY-2", transitionId: "21" }, { fieldIds }),
    ).toEqual({
      method: "POST",
      path: "issue/PAY-2/transitions",
      body: { transition: { id: "21" } },
    });
  });

  test("field updates include only the fields given; null clears", () => {
    expect(
      buildJiraWrite(
        {
          kind: "update_fields",
          issueKey: "PAY-2",
          fields: { priority: "High", dueDate: null, descriptionWiki: "h2. x" },
        },
        { fieldIds },
      ),
    ).toEqual({
      method: "PUT",
      path: "issue/PAY-2",
      body: { fields: { priority: { name: "High" }, duedate: null, description: "h2. x" } },
    });
  });

  test("assign and unassign use the DC username form", () => {
    expect(
      buildJiraWrite({ kind: "assign", issueKey: "PAY-2", username: "ana.b" }, { fieldIds }).body,
    ).toEqual({ name: "ana.b" });
    expect(
      buildJiraWrite({ kind: "assign", issueKey: "PAY-2", username: null }, { fieldIds }).body,
    ).toEqual({ name: null });
  });

  test("set_epic writes the Epic Link field when edit metadata allows it", () => {
    expect(
      buildJiraWrite(
        { kind: "set_epic", issueKey: "PAY-2", epicKey: "PAY-1" },
        { fieldIds, editMeta: meta },
      ).body,
    ).toEqual({
      fields: { customfield_10100: "PAY-1" },
    });
  });

  test("set_epic falls back to parent when only parent is editable", () => {
    const parentOnly = { fields: { parent: { name: "Parent", required: false } } };
    expect(
      buildJiraWrite(
        { kind: "set_epic", issueKey: "NEW-2", epicKey: "NEW-1" },
        { fieldIds, editMeta: parentOnly },
      ).body,
    ).toEqual({
      fields: { parent: { key: "NEW-1" } },
    });
  });

  test("set_epic fails clearly when neither field is editable", () => {
    expect(() =>
      buildJiraWrite(
        { kind: "set_epic", issueKey: "PAY-3", epicKey: "PAY-1" },
        { fieldIds, editMeta: { fields: {} } },
      ),
    ).toThrow("Neither Epic Link nor parent");
  });

  test("keys with special characters are encoded in paths", () => {
    expect(
      buildJiraWrite({ kind: "transition", issueKey: "A_B-1", transitionId: "1" }, { fieldIds })
        .path,
    ).toBe("issue/A_B-1/transitions");
  });
});

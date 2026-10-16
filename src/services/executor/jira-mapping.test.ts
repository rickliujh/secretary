import { describe, expect, test } from "bun:test";
import { EditMetaSchema } from "@/services/jira";
import { withProvenance } from "@/services/small-asks/home";
import editmeta from "@/test/fixtures/jira/editmeta-PAY-2.json";
import { JiraActionSchema } from "./actions";
import {
  buildCreateIssue,
  buildJiraWrite,
  buildMoveToSprint,
  descriptionToWiki,
  droppedFieldsWarning,
  MAX_SPRINT_MOVE_ISSUES,
  proposalTextToWiki,
  teamFieldValue,
} from "./jira-mapping";

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

describe("remote links", () => {
  test("upsert posts a globalId so repeats update; delete targets the globalId", () => {
    const up = buildJiraWrite(
      {
        kind: "upsert_remote_link",
        issueKey: "PAY-2",
        globalId: "secretary:dependency:d1",
        url: "https://snow/INC1",
        title: "Waiting on INC1",
        resolved: false,
      },
      { fieldIds },
    );
    expect(up).toEqual({
      method: "POST",
      path: "issue/PAY-2/remotelink",
      body: {
        globalId: "secretary:dependency:d1",
        application: { type: "secretary", name: "Secretary" },
        relationship: "waits on",
        object: { url: "https://snow/INC1", title: "Waiting on INC1", status: { resolved: false } },
      },
    });
    expect(
      buildJiraWrite(
        { kind: "delete_remote_link", issueKey: "PAY-2", globalId: "secretary:dependency:d1" },
        { fieldIds },
      ),
    ).toEqual({
      method: "DELETE",
      path: "issue/PAY-2/remotelink?globalId=secretary%3Adependency%3Ad1",
    });
  });
});

describe("sprint moves (Agile API)", () => {
  test("move_to_sprint posts the issue key to the sprint's issue list", () => {
    expect(
      buildJiraWrite(
        { kind: "move_to_sprint", issueKey: "PAY-4", sprintId: 44, sprintName: "Payments 16" },
        { fieldIds },
      ),
    ).toEqual({
      method: "POST",
      api: "agile",
      path: "sprint/44/issue",
      body: { issues: ["PAY-4"] },
    });
    // Same request on Cloud.
    expect(
      buildJiraWrite(
        { kind: "move_to_sprint", issueKey: "PAY-4", sprintId: 44 },
        { fieldIds, deployment: "cloud" },
      ).path,
    ).toBe("sprint/44/issue");
  });

  test("batches take up to 50 issues and refuse empty or invalid requests", () => {
    const keys = Array.from({ length: MAX_SPRINT_MOVE_ISSUES }, (_, i) => `PAY-${i + 1}`);
    expect(buildMoveToSprint(7, keys).body).toEqual({ issues: keys });
    expect(() => buildMoveToSprint(7, [...keys, "PAY-99"])).toThrow("at most 50");
    expect(() => buildMoveToSprint(7, [])).toThrow("No issues");
    expect(() => buildMoveToSprint(0, ["PAY-1"])).toThrow("Invalid sprint id");
  });
});

describe("buildCreateIssue", () => {
  const input = {
    projectKey: "ASK",
    issueTypeId: "2",
    issueTypeName: "Task",
    summary: "Send the Q3 numbers",
    descriptionMd: "**Asked** by Dana",
    parent: null,
    epic: null,
    priority: null,
    assignee: "rliu",
    dueDate: "2026-09-25",
  };
  const field = (fieldId: string, required = false) => ({ fieldId, name: fieldId, required });
  const screen = ["project", "issuetype", "summary", "description", "assignee", "duedate"].map(
    (f) => field(f),
  );

  test("labels are sent when the create screen has the field (D44)", () => {
    const plan = buildCreateIssue(
      { ...input, labels: ["small-ask", "small-ask"] },
      { fieldIds: {}, fields: [...screen, field("labels")] },
    );
    expect(plan.request.body).toEqual({
      fields: {
        project: { key: "ASK" },
        issuetype: { id: "2" },
        summary: "Send the Q3 numbers",
        description: "*Asked* by Dana",
        assignee: { name: "rliu" },
        duedate: "2026-09-25",
        labels: ["small-ask"],
      },
    });
    expect(plan.dropped).toEqual({ labels: [], assignee: null, description: false });
  });

  test("without a Labels field the labels are reported as dropped, not sent", () => {
    const plan = buildCreateIssue(
      { ...input, labels: ["small-ask"] },
      { deployment: "cloud", fieldIds: {}, fields: screen },
    );
    const fields = (plan.request.body as { fields: Record<string, unknown> }).fields;
    expect(fields.labels).toBeUndefined();
    expect(fields.assignee).toEqual({ id: "rliu" });
    expect(plan.dropped.labels).toEqual(["small-ask"]);
  });

  test("assignee and description missing from the screen are reported, like labels", () => {
    const bare = ["project", "issuetype", "summary", "duedate"].map((f) => field(f));
    const plan = buildCreateIssue(
      { ...input, labels: ["small-ask"] },
      { fieldIds: {}, fields: bare },
    );
    const fields = (plan.request.body as { fields: Record<string, unknown> }).fields;
    expect(fields).not.toHaveProperty("assignee");
    expect(fields).not.toHaveProperty("description");
    expect(plan.dropped).toEqual({ labels: ["small-ask"], assignee: "rliu", description: true });
    expect(droppedFieldsWarning(plan.dropped, "Task", "ASK")).toBe(
      "The Task create screen in ASK has no Labels, Assignee or Description field, so the label small-ask was not set and it was not assigned to rliu and the description (with who asked) was not sent.",
    );
    expect(
      droppedFieldsWarning({ labels: [], assignee: "rliu", description: false }, "Bug", "ASK"),
    ).toBe("The Bug create screen in ASK has no Assignee field, so it was not assigned to rliu.");
    expect(
      droppedFieldsWarning({ labels: [], assignee: null, description: false }, "Bug", "ASK"),
    ).toBeNull();
  });

  test("Jira's sub-task flag decides, not the type name", () => {
    const ctx = { fieldIds: {}, fields: [...screen, field("parent")] };
    // A sub-task type named "Action" needs its parent.
    expect(() =>
      buildCreateIssue({ ...input, issueTypeName: "Action", subtask: true }, ctx),
    ).toThrow("needs a parent");
    const sub = buildCreateIssue(
      { ...input, issueTypeName: "Action", subtask: true, parent: "ASK-1" },
      ctx,
    );
    expect((sub.request.body as { fields: Record<string, unknown> }).fields.parent).toEqual({
      key: "ASK-1",
    });
    // A standard type that happens to be called "Subtask review" takes an epic as parent.
    const std = buildCreateIssue(
      { ...input, issueTypeName: "Subtask review", subtask: false, epic: "ASK-9" },
      { ...ctx, deployment: "cloud" },
    );
    expect((std.request.body as { fields: Record<string, unknown> }).fields.parent).toEqual({
      key: "ASK-9",
    });
  });

  test("a create without labels (stored before labels existed) sends none", () => {
    const plan = buildCreateIssue(input, { fieldIds: {}, fields: [...screen, field("labels")] });
    expect((plan.request.body as { fields: object }).fields).not.toHaveProperty("labels");
  });

  describe("story points (D55)", () => {
    // A Cloud site with both fields; this project's screen has only "Story Points".
    const ids = { storyPoints: "customfield_10016", storyPointsAlt: ["customfield_10026"] };
    const fieldsOf = (plan: ReturnType<typeof buildCreateIssue>) =>
      (plan.request.body as { fields: Record<string, unknown> }).fields;

    test("go to the first story point field on the create screen, as a number", () => {
      const plan = buildCreateIssue(
        { ...input, storyPoints: 3 },
        { fieldIds: ids, fields: [...screen, field("customfield_10026")] },
      );
      expect(fieldsOf(plan).customfield_10026).toBe(3);
      expect(fieldsOf(plan)).not.toHaveProperty("customfield_10016");
      expect(plan.dropped.storyPoints).toBeUndefined();
      const both = buildCreateIssue(
        { ...input, storyPoints: 0.5 },
        {
          fieldIds: ids,
          fields: [...screen, field("customfield_10026"), field("customfield_10016")],
        },
      );
      expect(fieldsOf(both).customfield_10016).toBe(0.5);
      expect(fieldsOf(both)).not.toHaveProperty("customfield_10026");
    });

    test("a screen without one creates without points and says so", () => {
      const plan = buildCreateIssue(
        { ...input, storyPoints: 3 },
        { fieldIds: ids, fields: screen },
      );
      expect(fieldsOf(plan)).not.toHaveProperty("customfield_10016");
      expect(plan.dropped.storyPoints).toBe(3);
      expect(droppedFieldsWarning(plan.dropped, "Task", "ASK")).toBe(
        "The Task create screen in ASK has no Story Points field, so it was created without its 3 points.",
      );
    });

    test("an Epic and a create without points send none and warn of nothing", () => {
      const fields = [...screen, field("customfield_10016"), field("customfield_10102")];
      const epic = buildCreateIssue(
        { ...input, issueTypeName: "Epic", storyPoints: 8 },
        { fieldIds: ids, fields },
      );
      expect(fieldsOf(epic)).not.toHaveProperty("customfield_10016");
      expect(epic.dropped.storyPoints).toBeUndefined();
      const none = buildCreateIssue({ ...input, storyPoints: null }, { fieldIds: ids, fields });
      expect(fieldsOf(none)).not.toHaveProperty("customfield_10016");
    });
  });
});

describe("update_fields with story points (D55)", () => {
  test("writes the field the Executor chose; null clears it", () => {
    const write = (storyPoints: number | null) =>
      buildJiraWrite(
        {
          kind: "update_fields",
          issueKey: "PAY-12",
          fields: { storyPoints },
          pointsField: "customfield_10106",
        },
        { fieldIds },
      );
    expect(write(5)).toEqual({
      method: "PUT",
      path: "issue/PAY-12",
      body: { fields: { customfield_10106: 5 } },
    });
    expect(write(null).body).toEqual({ fields: { customfield_10106: null } });
  });

  test("points without a field are refused", () => {
    expect(
      JiraActionSchema.safeParse({
        kind: "update_fields",
        issueKey: "PAY-12",
        fields: { storyPoints: 5 },
      }).success,
    ).toBe(false);
    expect(() =>
      buildJiraWrite(
        { kind: "update_fields", issueKey: "PAY-12", fields: { storyPoints: 5 } },
        { fieldIds },
      ),
    ).toThrow("No story point field");
  });
});

describe("update_fields with the team (D59)", () => {
  const withTeam = { ...fieldIds, team: "customfield_10108", teamEditable: true };
  const write = (team: string | null, deployment?: "cloud" | "datacenter") =>
    buildJiraWrite(
      { kind: "update_fields", issueKey: "PAY-12", fields: { team, labels: ["x"] } },
      { fieldIds: withTeam, deployment },
    ).body;

  test("Data Center takes a number, Cloud the id string; null clears it; one PUT", () => {
    expect(write("14")).toEqual({ fields: { labels: ["x"], customfield_10108: 14 } });
    expect(write("5f0c-14", "cloud")).toEqual({
      fields: { labels: ["x"], customfield_10108: "5f0c-14" },
    });
    expect(write("14", "cloud")).toEqual({ fields: { labels: ["x"], customfield_10108: "14" } });
    expect(write(null)).toEqual({ fields: { labels: ["x"], customfield_10108: null } });
    expect(teamFieldValue("ab-1", "datacenter")).toBe("ab-1");
  });

  test("without a Team field it fails, saying what to do", () => {
    expect(() =>
      buildJiraWrite(
        { kind: "update_fields", issueKey: "PAY-12", fields: { team: "14" } },
        { fieldIds },
      ),
    ).toThrow(
      "No Team field was found in Jira, so the team of PAY-12 cannot be set. Set the field in Settings > Jira, or leave the team as it was.",
    );
  });

  test("a field only named Team (perhaps a select list) is never written", () => {
    expect(() =>
      buildJiraWrite(
        { kind: "update_fields", issueKey: "PAY-12", fields: { team: "10200", labels: ["x"] } },
        { fieldIds: { ...fieldIds, team: "customfield_3" } },
      ),
    ).toThrow("The field customfield_3 is named Team but is not a Jira team field");
  });
});

describe("update_fields with labels (D58)", () => {
  test("writes the whole list; an empty list clears them", () => {
    const write = (labels: string[]) =>
      buildJiraWrite(
        { kind: "update_fields", issueKey: "PAY-12", fields: { labels } },
        { fieldIds },
      );
    expect(write(["billing", "q4"])).toEqual({
      method: "PUT",
      path: "issue/PAY-12",
      body: { fields: { labels: ["billing", "q4"] } },
    });
    expect(write([]).body).toEqual({ fields: { labels: [] } });
  });

  test("a label with a space is refused", () => {
    expect(
      JiraActionSchema.safeParse({
        kind: "update_fields",
        issueKey: "PAY-12",
        fields: { labels: ["two words"] },
      }).success,
    ).toBe(false);
  });
});

describe("pasted text in a small ask's description (D44)", () => {
  const hostile = [
    "![](https://x/p.png)",
    "[~jsmith]",
    "{color:red}x{color}",
    "!http://x/p.png!",
    "[link|http://x]",
    "{noformat}",
    "{code}x{code}",
  ].join("\n");
  const md = withProvenance("Send the **numbers**.", {
    requester: "Dana Reyes",
    source: "teams",
    date: "2026-10-01",
    quote: hostile,
  });

  test("the quote reaches Jira as one literal noformat block", () => {
    const wiki = descriptionToWiki(md);
    expect(wiki).toBe(
      [
        "Send the *numbers*.",
        "_Asked by Dana Reyes via Teams on 2026-10-01:_",
        "{noformat}",
        "![](https://x/p.png)",
        "[~jsmith]",
        "{color:red}x{color}",
        "!http://x/p.png!",
        "[link|http://x]",
        "{ noformat}",
        "{ code}x{ code}",
        "{noformat}",
      ]
        .join("\n")
        .replace("_\n{noformat}", "_\n\n{noformat}")
        .replace(".\n_Asked", ".\n\n_Asked"),
    );
    // Only the closing marker ends the block: the one in the text was broken up.
    expect(wiki.match(/\{noformat\}/g)).toHaveLength(2);
    // Outside the block nothing from the paste became markup.
    const outside = wiki.replace(/\{noformat\}[\s\S]*\{noformat\}/, "");
    expect(outside).not.toMatch(/!https?:|\[~|\{color|\[link\|/);
  });

  test("a description without the block converts as before", () => {
    expect(descriptionToWiki("Do **it**")).toBe("Do *it*");
  });

  test("the create request carries the literal quote", () => {
    const plan = buildCreateIssue(
      {
        projectKey: "ASK",
        issueTypeId: "2",
        issueTypeName: "Task",
        summary: "Send it",
        descriptionMd: md,
        parent: null,
        epic: null,
        priority: null,
        assignee: null,
        dueDate: null,
      },
      { fieldIds: {}, fields: [{ fieldId: "description", name: "Description", required: false }] },
    );
    const body = plan.request.body as { fields: { description: string } };
    expect(body.fields.description).toBe(descriptionToWiki(md));
  });
});

describe("proposal text bound for Jira (D51)", () => {
  const create = (descriptionMd: string, knownUsers: string[]) =>
    buildCreateIssue(
      {
        projectKey: "ASK",
        issueTypeId: "2",
        issueTypeName: "Task",
        summary: "Send it",
        descriptionMd,
        parent: null,
        epic: null,
        priority: null,
        assignee: null,
        dueDate: null,
      },
      {
        fieldIds: {},
        fields: [{ fieldId: "description", name: "Description", required: false }],
        knownUsers,
      },
    );

  test("a create's description has remote images as links and strangers as text", () => {
    const plan = create("See ![](https://x.io/p.png), ask [~jsmith] and [~ana.b]", ["ana.b"]);
    expect((plan.request.body as { fields: { description: string } }).fields.description).toBe(
      "See [https://x.io/p.png], ask \\[~jsmith] and [~ana.b]",
    );
    expect(plan.safety).toEqual({ images: ["https://x.io/p.png"], mentions: ["jsmith"] });
  });

  test("a small ask's literal quote is not counted or changed", () => {
    const md = withProvenance("Send it.", {
      requester: "Dana",
      source: "teams",
      date: "2026-10-01",
      quote: "![](https://x/p.png) [~jsmith]",
    });
    const plan = create(md, []);
    expect(plan.safety).toEqual({ images: [], mentions: [] });
    expect((plan.request.body as { fields: { description: string } }).fields.description).toBe(
      descriptionToWiki(md),
    );
  });

  test("an edit that leaves the block not last: the quote converts, but images and strangers are made safe", () => {
    const md = `${withProvenance("Send it.", {
      requester: "Dana",
      source: "teams",
      date: "2026-10-01",
      quote: "![](https://x/p.png) !https://x/q.png|width=1! [~jsmith] [Boss|~boss]",
    })}\n\nAdded by me after the quote.`;
    const safe = proposalTextToWiki(md, []);
    // Not the literal block any more (D44), but D51 still applies to the whole text.
    expect(safe.wiki).not.toContain("{noformat}");
    expect(safe.wiki).not.toMatch(/(?<!\\)!(https?:|\/\/)/);
    expect(safe.wiki).not.toMatch(/(?<!\\)\[(?:[^\]|]*\|)?~/);
    expect(safe.images).toEqual(["https://x/p.png", "https://x/q.png"]);
    expect(safe.mentions).toEqual(["jsmith", "boss"]);
  });

  test("the requester's name in the Asked by line is text, not markup", () => {
    const md = withProvenance("Send it.", {
      requester: "[~boss] ![](https://x/p.png) {color:red}x{color} [a](http://evil.example) *b*",
      source: "email",
      date: "2026-10-01",
      quote: "q",
    });
    const safe = proposalTextToWiki(md, []);
    const line = safe.wiki.split("\n").find((l) => l.includes("Asked by")) ?? "";
    expect(line).toStartWith("_Asked by ");
    expect(line).toEndWith(" via email on 2026-10-01:_");
    const name = line.slice("_Asked by ".length, -" via email on 2026-10-01:_".length);
    // Every wiki markup character in the name is escaped, so Jira shows it as typed.
    expect(name).not.toMatch(/(?<!\\)[[\]{}!*_~|^+?#-]/);
    expect(name.replace(/\\(.)/g, "$1")).toBe(
      "[~boss] ![](https://x/p.png) {color:red}x{color} [a](http://evil.example) *b*",
    );
    expect(safe).toMatchObject({ images: [], mentions: [] });
  });

  describe("a block marker the model leaves open cannot capture the quote", () => {
    const quote = "![](https://x/p.png) [~jsmith] {color:red}x{color}";
    const ask = (base: string) =>
      proposalTextToWiki(
        withProvenance(base, { requester: "Dana", source: "teams", date: "2026-10-01", quote }),
        [],
      ).wiki;
    const quoteBlock = `{noformat}\n${quote}\n{noformat}`;

    test.each([
      ["noformat", "Check {noformat} this"],
      ["code", "Check {code} this"],
      ["upper-case", "Check {NOFORMAT} this"],
      ["with params", "Check {noformat:nopanel=true} this"],
      ["a closer only", "Check this{noformat}"],
    ])("an unclosed %s marker", (_n, base) => {
      const wiki = ask(base);
      // The quote is the one and only noformat block, right after the Asked by line.
      expect(wiki).toEndWith(`_Asked by Dana via Teams on 2026-10-01:_\n\n${quoteBlock}`);
      expect(wiki.match(/\{noformat\}/g)).toHaveLength(2);
      expect(wiki.match(/\{code\}/gi) ?? []).toHaveLength(0);
    });

    test("the model's balanced fenced code still goes out as a code block", () => {
      const wiki = ask("Run this:\n\n```js\nconst a = '!https://x/p.png!';\n```");
      expect(wiki).toBe(
        [
          "Run this:",
          "",
          "{code:js}\nconst a = '!https://x/p.png!';\n{code}",
          "",
          "_Asked by Dana via Teams on 2026-10-01:_",
          "",
          quoteBlock,
        ].join("\n"),
      );
    });
  });

  test("proposalTextToWiki converts, keeps the quote literal, then makes safe", () => {
    expect(proposalTextToWiki("**Hi** [~bob] !https://x/i.png!", ["bob"])).toEqual({
      wiki: "*Hi* [~bob] [https://x/i.png]",
      images: ["https://x/i.png"],
      mentions: [],
    });
  });

  test("a comment action with prepared wiki sends it as is; one without converts", () => {
    const w = (bodyWiki?: string) =>
      buildJiraWrite(
        { kind: "add_comment", issueKey: "PAY-2", bodyMarkdown: "![](https://x/p.png)", bodyWiki },
        { fieldIds },
      ).body;
    expect(w("[https://x/p.png]")).toEqual({ body: "[https://x/p.png]" });
    // The user's own comment from the ticket view is theirs (D51).
    expect(w()).toEqual({ body: "!https://x/p.png!" });
  });
});

describe("reverse writes (D54)", () => {
  test("delete an issue without its sub-tasks, delete a comment, move to the backlog", () => {
    expect(buildJiraWrite({ kind: "delete_issue", issueKey: "PAY-12" }, { fieldIds })).toEqual({
      method: "DELETE",
      path: "issue/PAY-12",
    });
    expect(
      buildJiraWrite(
        { kind: "delete_comment", issueKey: "PAY-12", commentId: "50004" },
        { fieldIds },
      ),
    ).toEqual({ method: "DELETE", path: "issue/PAY-12/comment/50004" });
    expect(buildJiraWrite({ kind: "move_to_backlog", issueKey: "PAY-12" }, { fieldIds })).toEqual({
      method: "POST",
      api: "agile",
      path: "backlog/issue",
      body: { issues: ["PAY-12"] },
    });
  });
});

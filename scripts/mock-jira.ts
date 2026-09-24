/**
 * A small fake Jira Data Center (REST v2) for local UI work without a real
 * instance. State lives in memory; writes from the app change it, so the next
 * sync picks them up.
 *
 *   bun run mock:jira                 # 3 epics, ~80 issues on http://localhost:8089
 *   bun run mock:jira --issues 2000   # larger data set for performance checks
 *   bun run mock:jira --port 9000
 *
 * In Settings > Jira use base URL http://localhost:8089 and any token.
 * JQL support is minimal: `updated >= "yyyy/MM/dd HH:mm"` (UTC) and
 * `parent in (...)` are honoured; everything else matches all issues.
 */
import j2m from "jira2md";

type User = { name: string; displayName: string; emailAddress: string };
type Comment = { id: string; author: User; body: string; created: string; updated: string };
type Issue = {
  id: string;
  key: string;
  project: string;
  type: "Epic" | "Story" | "Task" | "Bug" | "Sub-task";
  summary: string;
  description: string | null;
  status: keyof typeof STATUSES;
  priority: string | null;
  assignee: User | null;
  reporter: User;
  epic: string | null;
  epicName: string | null;
  parent: string | null;
  labels: string[];
  due: string | null;
  created: string;
  updated: string;
  comments: Comment[];
  links: { type: "Blocks"; inward: string }[];
  remoteLinks?: {
    id: number;
    globalId: string;
    object: { url: string; title: string; summary?: string; status?: { resolved: boolean } };
  }[];
};

const STATUSES = {
  "To Do": { id: "10000", category: "new" },
  "In Progress": { id: "3", category: "indeterminate" },
  Blocked: { id: "10400", category: "indeterminate" },
  "In Review": { id: "10401", category: "indeterminate" },
  Done: { id: "10002", category: "done" },
} as const;
const TRANSITIONS = Object.keys(STATUSES).map((name, i) => ({
  id: String((i + 1) * 10 + 1),
  name,
}));
const PRIORITIES = ["Highest", "High", "Medium", "Low", "Lowest"];
const EPIC_LINK = "customfield_10100";
const EPIC_NAME = "customfield_10102";
const SPRINT = "customfield_10104";

const USERS: User[] = [
  { name: "me", displayName: "Me Myself", emailAddress: "me@example.com" },
  { name: "ana.b", displayName: "Ana Bell", emailAddress: "ana@example.com" },
  { name: "tom.k", displayName: "Tom Kay", emailAddress: "tom@example.com" },
  { name: "priya.s", displayName: "Priya Shah", emailAddress: "priya@example.com" },
];

const args = process.argv.slice(2);
const flag = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};

// Deterministic pseudo-random numbers so every run produces the same data.
let seed = 42;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2 ** 31;
  return seed / 2 ** 31;
};
const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;

const TOPICS = [
  "invoice export",
  "ledger mapping",
  "refund totals",
  "VAT rounding",
  "payment retries",
  "firewall rule",
  "audit trail",
  "currency table",
  "report schedule",
  "API rate limit",
];
const VERBS = ["Fix", "Add", "Migrate", "Document", "Review", "Automate", "Investigate"];

export function generate(total: number): Map<string, Issue> {
  const issues = new Map<string, Issue>();
  const counters: Record<string, number> = { PAY: 0, OPS: 0 };
  const start = Date.UTC(2026, 6, 1);
  const iso = (t: number) => new Date(t).toISOString().replace("Z", "+0000");
  let clock = start;
  const next = () => {
    clock += Math.floor(rand() * 6 * 3600 * 1000);
    return iso(clock);
  };
  const make = (project: string, type: Issue["type"], extra: Partial<Issue> = {}): Issue => {
    counters[project] = (counters[project] ?? 0) + 1;
    const topic = pick(TOPICS);
    const created = next();
    const issue: Issue = {
      id: String(20000 + issues.size),
      key: `${project}-${counters[project]}`,
      project,
      type,
      summary: `${pick(VERBS)} ${topic}`,
      description: `Context for the ${topic} work.\n\nh3. Notes\n* check with the platform team\n* see {{INC00${Math.floor(10000 + rand() * 89999)}}}`,
      status: pick(Object.keys(STATUSES) as (keyof typeof STATUSES)[]),
      priority: pick(PRIORITIES),
      assignee: rand() < 0.2 ? null : pick(USERS),
      reporter: pick(USERS),
      epic: null,
      epicName: null,
      parent: null,
      labels: rand() < 0.3 ? [topic.split(" ")[0] ?? "misc"] : [],
      due:
        rand() < 0.3 ? new Date(start + rand() * 200 * 86400000).toISOString().slice(0, 10) : null,
      created,
      updated: created,
      comments: [],
      links: [],
      ...extra,
    };
    const n = Math.floor(rand() * 5);
    for (let c = 0; c < n; c++) {
      const at = next();
      issue.comments.push({
        id: String(50000 + issues.size * 10 + c),
        author: pick(USERS),
        body: `Update ${c + 1}: *progress* on ${topic}.`,
        created: at,
        updated: at,
      });
      issue.updated = at;
    }
    issues.set(issue.key, issue);
    return issue;
  };

  const epics = ["Billing migration", "Ledger cutover", "Ops hardening"].map((name, i) =>
    make(i < 2 ? "PAY" : "OPS", "Epic", { summary: name, epicName: name, status: "In Progress" }),
  );
  while (issues.size < total) {
    const epic = rand() < 0.8 ? pick(epics) : null;
    const project = epic?.project ?? pick(["PAY", "OPS"]);
    const story = make(project, pick(["Story", "Task", "Bug"] as const), {
      epic: epic?.key ?? null,
    });
    if (issues.size < total && rand() < 0.4)
      make(project, "Sub-task", { parent: story.key, epic: null });
    if (rand() < 0.1) {
      const other = pick([...issues.values()]);
      if (other.key !== story.key) story.links.push({ type: "Blocks", inward: other.key });
    }
  }
  return issues;
}

const userJson = (u: User | null) =>
  u ? { ...u, key: `JIRAUSER-${u.name}`, active: true, timeZone: "UTC" } : null;
const status = (name: keyof typeof STATUSES) => ({
  id: STATUSES[name].id,
  name,
  statusCategory: { key: STATUSES[name].category, name: STATUSES[name].category },
});
const commentJson = (c: Comment) => ({
  ...c,
  author: userJson(c.author),
  renderedBody: j2m.jira_to_html(c.body),
});

function issueJson(issue: Issue, all: Map<string, Issue>, embedComments = 2) {
  const parent = issue.parent ? all.get(issue.parent) : undefined;
  return {
    id: issue.id,
    key: issue.key,
    self: `/rest/api/2/issue/${issue.id}`,
    fields: {
      summary: issue.summary,
      description: issue.description,
      issuetype: { id: issue.type, name: issue.type, subtask: issue.type === "Sub-task" },
      project: {
        id: issue.project,
        key: issue.project,
        name: issue.project === "PAY" ? "Payments" : "Operations",
      },
      status: status(issue.status),
      priority: issue.priority
        ? { name: issue.priority, id: String(PRIORITIES.indexOf(issue.priority) + 1) }
        : null,
      assignee: userJson(issue.assignee),
      reporter: userJson(issue.reporter),
      parent: parent
        ? {
            id: parent.id,
            key: parent.key,
            fields: { summary: parent.summary, issuetype: { name: parent.type, subtask: false } },
          }
        : undefined,
      labels: issue.labels,
      components: [],
      duedate: issue.due,
      created: issue.created,
      updated: issue.updated,
      resolutiondate: issue.status === "Done" ? issue.updated : null,
      [EPIC_LINK]: issue.epic,
      [EPIC_NAME]: issue.epicName,
      [SPRINT]:
        issue.type === "Epic"
          ? null
          : [
              `com.atlassian.greenhopper.service.sprint.Sprint@1[id=7,rapidViewId=1,state=ACTIVE,name=Sprint 7,startDate=2026-09-14T09:00:00.000Z,sequence=7]`,
            ],
      issuelinks: issue.links.map((l, i) => {
        const other = all.get(l.inward);
        return {
          id: `${issue.id}${i}`,
          type: { name: "Blocks", inward: "is blocked by", outward: "blocks" },
          inwardIssue: other
            ? {
                key: other.key,
                fields: {
                  summary: other.summary,
                  status: status(other.status),
                  issuetype: { name: other.type, subtask: false },
                },
              }
            : undefined,
        };
      }),
      attachment: [],
      comment: {
        comments: issue.comments.slice(0, embedComments).map(commentJson),
        maxResults: embedComments,
        total: issue.comments.length,
        startAt: 0,
      },
    },
    renderedFields: {
      description: issue.description ? j2m.jira_to_html(issue.description) : null,
      comment: {
        comments: issue.comments
          .slice(0, embedComments)
          .map((c) => ({ id: c.id, body: j2m.jira_to_html(c.body) })),
      },
    },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const error = (message: string, status = 400) =>
  json({ errorMessages: [message], errors: {} }, status);

/** "2026/09/21 16:35" (interpreted as UTC by this mock). */
const parseJqlDate = (s: string) =>
  new Date(`${s.replace(/\//g, "-").replace(" ", "T")}:00Z`).getTime();

export function createHandler(issues: Map<string, Issue>) {
  const touch = (issue: Issue) => {
    issue.updated = new Date().toISOString().replace("Z", "+0000");
  };
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (!req.headers.get("authorization")?.startsWith("Bearer "))
      return new Response("", { status: 401 });
    const path = url.pathname.replace(/^\/rest\/api\/2\//, "");
    const body =
      req.method === "GET"
        ? undefined
        : ((await req.json().catch(() => undefined)) as Record<string, unknown> | undefined);

    if (path === "myself") return json({ ...userJson(USERS[0] ?? null), timeZone: "UTC" });
    if (path === "field")
      return json([
        {
          id: "summary",
          name: "Summary",
          custom: false,
          schema: { type: "string", system: "summary" },
        },
        {
          id: EPIC_LINK,
          name: "Epic Link",
          custom: true,
          schema: {
            type: "any",
            custom: "com.pyxis.greenhopper.jira:gh-epic-link",
            customId: 10100,
          },
        },
        {
          id: EPIC_NAME,
          name: "Epic Name",
          custom: true,
          schema: {
            type: "string",
            custom: "com.pyxis.greenhopper.jira:gh-epic-label",
            customId: 10102,
          },
        },
        {
          id: SPRINT,
          name: "Sprint",
          custom: true,
          schema: {
            type: "array",
            items: "string",
            custom: "com.pyxis.greenhopper.jira:gh-sprint",
            customId: 10104,
          },
        },
      ]);
    if (path === "priority")
      return json(PRIORITIES.map((name, i) => ({ id: String(i + 1), name })));
    if (path === "project")
      return json([
        { id: "PAY", key: "PAY", name: "Payments" },
        { id: "OPS", key: "OPS", name: "Operations" },
      ]);
    if (path === "user/assignable/search") {
      const q = (url.searchParams.get("username") ?? "").toLowerCase();
      return json(
        USERS.filter((u) => `${u.name} ${u.displayName}`.toLowerCase().includes(q)).map(userJson),
      );
    }
    if (path === "search" && req.method === "POST") {
      const jql = String(body?.jql ?? "");
      const startAt = Number(body?.startAt ?? 0);
      const max = Math.min(Number(body?.maxResults ?? 50), 100);
      let list = [...issues.values()];
      const parents = /^\(parent in \(([^)]*)\)\)/.exec(jql)?.[1]?.split(/,\s*/);
      if (parents) list = list.filter((i) => i.parent && parents.includes(i.parent));
      const since = /updated >= "([^"]+)"/.exec(jql)?.[1];
      if (since)
        list = list.filter(
          (i) => new Date(i.updated.replace("+0000", "Z")).getTime() >= parseJqlDate(since),
        );
      list.sort((a, b) => a.updated.localeCompare(b.updated));
      return json({
        startAt,
        maxResults: max,
        total: list.length,
        issues: list.slice(startAt, startAt + max).map((i) => issueJson(i, issues)),
      });
    }

    const meta = /^issue\/createmeta\/([A-Z]+)\/issuetypes(?:\/(\w[\w-]*))?$/.exec(path);
    if (meta) {
      const types = ["Epic", "Story", "Task", "Bug", "Sub-task"] as const;
      if (!meta[2])
        return json({
          isLast: true,
          values: types.map((t) => ({ id: t, name: t, subtask: t === "Sub-task" })),
        });
      const fieldsMeta = [
        { fieldId: "project", name: "Project", required: true },
        { fieldId: "issuetype", name: "Issue Type", required: true },
        { fieldId: "summary", name: "Summary", required: true },
        { fieldId: "description", name: "Description", required: false },
        { fieldId: "priority", name: "Priority", required: false, hasDefaultValue: true },
        { fieldId: "assignee", name: "Assignee", required: false },
        { fieldId: "duedate", name: "Due Date", required: false },
        ...(meta[2] === "Sub-task" ? [{ fieldId: "parent", name: "Parent", required: true }] : []),
        ...(meta[2] === "Epic" ? [{ fieldId: EPIC_NAME, name: "Epic Name", required: true }] : []),
        ...(meta[2] !== "Epic" && meta[2] !== "Sub-task"
          ? [{ fieldId: EPIC_LINK, name: "Epic Link", required: false }]
          : []),
      ];
      return json({ isLast: true, values: fieldsMeta });
    }
    if (path === "issue" && req.method === "POST") {
      const f = (body?.fields ?? {}) as Record<string, unknown>;
      const project = (f.project as { key?: string } | undefined)?.key ?? "";
      const type = (f.issuetype as { id?: string } | undefined)?.id as Issue["type"] | undefined;
      if (!["PAY", "OPS"].includes(project) || !type)
        return error("project and issuetype are required");
      if (type === "Epic" && !f[EPIC_NAME])
        return json({ errorMessages: [], errors: { [EPIC_NAME]: "Epic Name is required." } }, 400);
      const count = [...issues.values()].filter((i) => i.project === project).length;
      const now = new Date().toISOString().replace("Z", "+0000");
      const created: Issue = {
        id: String(30000 + issues.size),
        key: `${project}-${count + 1}`,
        project,
        type,
        summary: String(f.summary ?? ""),
        description: (f.description as string | undefined) ?? null,
        status: "To Do",
        priority: (f.priority as { name?: string } | undefined)?.name ?? "Medium",
        assignee:
          USERS.find((u) => u.name === (f.assignee as { name?: string } | undefined)?.name) ?? null,
        reporter: USERS[0] as User,
        epic: (f[EPIC_LINK] as string | undefined) ?? null,
        epicName: (f[EPIC_NAME] as string | undefined) ?? null,
        parent: (f.parent as { key?: string } | undefined)?.key ?? null,
        labels: [],
        due: (f.duedate as string | undefined) ?? null,
        created: now,
        updated: now,
        comments: [],
        links: [],
      };
      issues.set(created.key, created);
      return json(
        { id: created.id, key: created.key, self: `/rest/api/2/issue/${created.id}` },
        201,
      );
    }

    const m = /^issue\/([^/]+)(\/.*)?$/.exec(path);
    const issue = m ? issues.get(decodeURIComponent(m[1] ?? "")) : undefined;
    if (m && !issue) return error("Issue Does Not Exist", 404);
    if (issue) {
      const sub = m?.[2] ?? "";
      if (sub === "" && req.method === "GET") return json(issueJson(issue, issues, 1000));
      if (sub === "" && req.method === "PUT") {
        const f = (body?.fields ?? {}) as Record<string, unknown>;
        if ("summary" in f) issue.summary = String(f.summary);
        if ("description" in f) issue.description = (f.description as string | null) ?? null;
        if ("priority" in f) issue.priority = (f.priority as { name: string } | null)?.name ?? null;
        if ("duedate" in f) issue.due = (f.duedate as string | null) ?? null;
        if (EPIC_LINK in f) {
          const epic = f[EPIC_LINK] as string | null;
          if (epic && issues.get(epic)?.type !== "Epic")
            return json(
              { errorMessages: [], errors: { [EPIC_LINK]: `Issue ${epic} is not an epic.` } },
              400,
            );
          issue.epic = epic;
        }
        touch(issue);
        return new Response(null, { status: 204 });
      }
      if (sub === "/assignee" && req.method === "PUT") {
        const name = body?.name as string | null;
        issue.assignee = name ? (USERS.find((u) => u.name === name) ?? null) : null;
        touch(issue);
        return new Response(null, { status: 204 });
      }
      if (sub === "/comment" && req.method === "GET")
        return json({
          startAt: 0,
          maxResults: 1000,
          total: issue.comments.length,
          comments: issue.comments.map(commentJson),
        });
      if (sub === "/comment" && req.method === "POST") {
        const now = new Date().toISOString().replace("Z", "+0000");
        const c: Comment = {
          id: String(90000 + Math.floor(rand() * 9999)),
          author: USERS[0] as User,
          body: String(body?.body ?? ""),
          created: now,
          updated: now,
        };
        issue.comments.push(c);
        touch(issue);
        return json(commentJson(c), 201);
      }
      if (sub === "/transitions" && req.method === "GET")
        return json({
          transitions: TRANSITIONS.filter((t) => t.name !== issue.status).map((t) => ({
            ...t,
            to: status(t.name as keyof typeof STATUSES),
          })),
        });
      if (sub === "/transitions" && req.method === "POST") {
        const t = TRANSITIONS.find(
          (x) => x.id === (body?.transition as { id?: string } | undefined)?.id,
        );
        if (!t)
          return error("It seems that you have tried to perform an illegal workflow operation.");
        issue.status = t.name as keyof typeof STATUSES;
        touch(issue);
        return new Response(null, { status: 204 });
      }
      if (sub === "/editmeta")
        return json({
          fields:
            issue.type === "Sub-task" || issue.type === "Epic"
              ? {}
              : { [EPIC_LINK]: { name: "Epic Link", required: false, operations: ["set"] } },
        });
      if (sub === "/remotelink" && req.method === "GET") return json(issue.remoteLinks ?? []);
      if (sub === "/remotelink" && req.method === "POST") {
        const links = (issue.remoteLinks ??= []);
        const globalId = String(body?.globalId ?? "");
        const object = body?.object as NonNullable<Issue["remoteLinks"]>[number]["object"];
        if (!object?.url || !object.title) return error("url and title are required");
        const existing = links.find((l) => globalId && l.globalId === globalId);
        if (existing) {
          existing.object = object;
          return json({
            id: existing.id,
            self: `/rest/api/2/issue/${issue.key}/remotelink/${existing.id}`,
          });
        }
        const id = 10000 + Math.floor(rand() * 89999);
        links.push({ id, globalId, object });
        return json({ id, self: `/rest/api/2/issue/${issue.key}/remotelink/${id}` }, 201);
      }
      if (sub === "/remotelink" && req.method === "DELETE") {
        const globalId = url.searchParams.get("globalId");
        issue.remoteLinks = (issue.remoteLinks ?? []).filter((l) => l.globalId !== globalId);
        return new Response(null, { status: 204 });
      }
    }
    return error(`Mock does not implement ${req.method} ${url.pathname}`, 404);
  };
}

if (import.meta.main) {
  const port = flag("port", 8089);
  const issues = generate(flag("issues", 80));
  Bun.serve({ port, fetch: createHandler(issues) });
  console.log(
    `Mock Jira DC on http://localhost:${port} with ${issues.size} issues (tracked epic suggestion: PAY-1)`,
  );
}

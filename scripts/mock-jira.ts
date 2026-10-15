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
 *
 * Boards: 1 (PAY) and 2 (OPS) run back-to-back two-week sprints from
 * 2026-06-29; the one covering today is active and two more are planned.
 * `/rest/agile/1.0/board/{id}/sprint` serves that history, and each issue's
 * Sprint field names the sprint it was created in, plus the active one when
 * unfinished work was carried over. `POST /rest/agile/1.0/sprint/{id}/issue`
 * moves issues into a sprint; an issue the app creates starts in the backlog,
 * as in Jira, until it is moved. Stories, tasks and bugs carry Story Points
 * (1, 2, 3, 5, 8, 13; some unestimated). Their create and edit screens have
 * the Story Points field (not Epic or Sub-task, D55); with --cloud also "Story
 * point estimate", empty until written, as on Cloud sites with both (D35).
 * Like Jira, a create or edit that sets a field its screen lacks, or points
 * that are not a number, is refused with 400.
 *
 * Change history: every other issue has a status change and some an assignee
 * change in the last few days, plus an older priority change; status,
 * assignee and priority writes from the app are recorded too. Served by
 * `GET /rest/api/2/issue/{key}?expand=changelog` (Data Center) and the
 * paginated `GET /rest/api/2/issue/{key}/changelog` (Cloud shape).
 *
 * Issue links (D45): `GET /issueLinkType`, `POST /issueLink`, `DELETE
 * /issueLink/{id}`, and `issuelinks` on every issue from both sides. A posted
 * Blocks link means "inwardIssue blocks outwardIssue"; `--reversed-links`
 * stores it the other way round, as some instances appear to. JQL
 * `key in (...)` on its own (the blocker check) returns just those keys; in the
 * Cloud shape one unknown key fails it with 400, as Cloud does. Tests can also
 * hide issues (403), move them to a new key, and cap the search page size.
 *
 * Revoking (D54): `DELETE /issue/{key}` (refused for an issue with sub-tasks,
 * and with 403 when `canDelete` is false), `GET /mypermissions`, `GET` and
 * `DELETE /issue/{key}/comment/{id}`, `POST /rest/agile/1.0/backlog/issue`, and
 * with `--cancel-status` a done-category Cancelled status. `--no-delete` plays a
 * user without the delete permission; tests can also refuse the delete of one
 * issue and the assigning of one user. Transitions follow a workflow: which are
 * available depends on the issue's status, and `POST /transitions` refuses one
 * that is not available from it. With `laggingSearch` (tests) a deleted issue
 * still comes back from searches, as Cloud's eventually consistent index may.
 *
 *   bun run mock:jira --cloud         # Cloud shape: Basic auth, POST /search/jql
 *                                     # token paging (old /search is 410), account
 *                                     # ids, parent epics, /priority/search
 */
import j2m from "jira2md";

type User = { name: string; displayName: string; emailAddress: string };
type Comment = { id: string; author: User; body: string; created: string; updated: string };
type ChangeItem = {
  field: string;
  from: string | null;
  fromString: string | null;
  to: string | null;
  toString: string | null;
};
type History = { id: string; author: User; created: string; items: ChangeItem[] };
type Issue = {
  id: string;
  key: string;
  project: string;
  type: (typeof ISSUE_TYPES)[number];
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
  /** Seeded links: this issue is blocked by `inward`. The handler keeps the live set. */
  links: { type: "Blocks"; inward: string }[];
  /** Story Points; null when unestimated. */
  points: number | null;
  /** Cloud's "Story point estimate" (--cloud only); empty unless written. */
  estimate?: number | null;
  /** Set when the issue was moved into a sprint through the Agile API. */
  movedToSprint?: number;
  /** Set when the issue was moved to the backlog through the Agile API: no open sprint. */
  inBacklog?: boolean;
  /** Changelog, oldest first. */
  history?: History[];
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
  /** A done-category status a revoked ticket can end in (D54); only with `cancelStatus`. */
  Cancelled: { id: "10003", category: "done" },
} as const;
/** Statuses seeded issues start in. */
const SEEDED_STATUSES = ["To Do", "In Progress", "Blocked", "In Review", "Done"] as const;
type StatusName = keyof typeof STATUSES;
const STATUS_NAMES = Object.keys(STATUSES) as StatusName[];
/**
 * The workflow: which statuses each status moves to. Like a real workflow it is
 * not global, so a transition id read in one status is refused in another.
 */
const WORKFLOW: Record<StatusName, readonly StatusName[]> = {
  "To Do": ["In Progress", "Blocked", "Done", "Cancelled"],
  "In Progress": ["To Do", "Blocked", "In Review", "Done", "Cancelled"],
  Blocked: ["To Do", "In Progress", "Done", "Cancelled"],
  "In Review": ["In Progress", "Blocked", "Done", "Cancelled"],
  Done: ["To Do", "In Progress"],
  Cancelled: ["To Do"],
};
/** The transitions out of a status; each id belongs to one from-to pair. */
const transitionsFrom = (from: StatusName) =>
  WORKFLOW[from].map((to) => ({
    id: String((STATUS_NAMES.indexOf(from) + 1) * 10 + STATUS_NAMES.indexOf(to) + 1),
    name: to,
  }));
const ISSUE_TYPES = ["Epic", "Story", "Task", "Bug", "Sub-task"] as const;
const LINK_TYPES = [
  { id: "10000", name: "Blocks", inward: "is blocked by", outward: "blocks" },
  { id: "10001", name: "Relates", inward: "relates to", outward: "relates to" },
  { id: "10002", name: "Duplicate", inward: "is duplicated by", outward: "duplicates" },
] as const;
/** A live link: "from <outward> to", e.g. from blocks to. */
export type MockLink = { id: string; type: (typeof LINK_TYPES)[number]; from: string; to: string };
const PRIORITIES = ["Highest", "High", "Medium", "Low", "Lowest"];
const EPIC_LINK = "customfield_10100";
const EPIC_NAME = "customfield_10102";
const SPRINT = "customfield_10104";
const STORY_POINTS = "customfield_10106";
/** Cloud's "Story point estimate" (jsw-story-points), served with --cloud beside Story Points (D35). */
const ESTIMATE = "customfield_10016";
/** Cycled by issue id so points do not disturb the seeded random sequence. */
const POINTS = [3, 1, 5, 2, 8, 3, null, 2, 5, 1, 3, 13, 2, null, 5, 1, 8] as const;

const HOUR = 3_600_000;
const DAY = 86_400_000;
const SPRINT_LENGTH = 14 * DAY;
/** Monday 09:00 UTC: the first sprint of every board starts here. */
const FIRST_SPRINT = Date.UTC(2026, 5, 29, 9);
const PLANNED_SPRINTS = 2;
const BOARDS = [
  { id: 1, project: "PAY", name: "Payments" },
  { id: 2, project: "OPS", name: "Ops" },
] as const;

type Sprint = {
  id: number;
  name: string;
  state: "closed" | "active" | "future";
  startDate: string;
  endDate: string;
  completeDate: string | null;
  originBoardId: number;
};

const jiraTime = (t: number) => new Date(t).toISOString().replace("Z", "+00:00");
/** Which sprint (0-based) was running at `t`; the first one covers anything earlier. */
const sprintIndex = (t: number) => Math.max(0, Math.floor((t - FIRST_SPRINT) / SPRINT_LENGTH));

/**
 * A board's sprints, oldest first: every sprint up to the active one, then the
 * planned ones. Each ends at 17:00 on the Monday the next one starts, as the
 * recorded fixture board does.
 */
export function boardSprints(boardId: number, now = Date.now()): Sprint[] {
  const board = BOARDS.find((b) => b.id === boardId);
  if (!board) return [];
  const active = sprintIndex(now);
  return Array.from({ length: active + 1 + PLANNED_SPRINTS }, (_, i) => {
    const start = FIRST_SPRINT + i * SPRINT_LENGTH;
    const end = start + SPRINT_LENGTH + 8 * 3600 * 1000;
    const state = i < active ? "closed" : i === active ? "active" : "future";
    return {
      id: board.id * 100 + i + 1,
      name: `${board.name} ${i + 1}`,
      state,
      startDate: jiraTime(start),
      endDate: jiraTime(end),
      completeDate: state === "closed" ? jiraTime(end + 5 * 60 * 1000) : null,
      originBoardId: board.id,
    };
  });
}

/** Data Center's legacy string form of a sprint, as the Sprint field returns it. */
const sprintString = (s: Sprint) =>
  `com.atlassian.greenhopper.service.sprint.Sprint@${s.id.toString(16)}[id=${s.id},rapidViewId=${s.originBoardId},state=${s.state.toUpperCase()},name=${s.name},startDate=${s.startDate},endDate=${s.endDate},completeDate=${s.completeDate ?? "<null>"},sequence=${s.id},goal=]`;

/**
 * The sprint the issue was created in, plus the active one if unfinished work
 * carried over, or plus the sprint it was moved into through the Agile API.
 */
function issueSprints(issue: Issue, now = Date.now()): string[] | null {
  if (issue.type === "Epic") return null;
  const board = BOARDS.find((b) => b.project === issue.project);
  if (!board) return null;
  const sprints = boardSprints(board.id, now);
  const active = sprintIndex(now);
  const createdAt = new Date(issue.created.replace("+0000", "Z")).getTime();
  const created = Math.min(sprintIndex(createdAt), active);
  if (issue.inBacklog)
    return [sprints[created]].filter((s): s is Sprint => s?.state === "closed").map(sprintString);
  const moved = sprints.findIndex((s) => s.id === issue.movedToSprint);
  if (moved >= 0)
    return (created < moved ? [sprints[created], sprints[moved]] : [sprints[moved]])
      .filter((s): s is Sprint => !!s)
      .map(sprintString);
  const picked = [sprints[created]];
  if (created < active && issue.status !== "Done") picked.push(sprints[active]);
  return picked.filter((s): s is Sprint => !!s).map(sprintString);
}

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

/** The status an issue plausibly came from, for seeded history. */
const PREVIOUS_STATUS: Record<keyof typeof STATUSES, keyof typeof STATUSES> = {
  "To Do": "In Progress",
  "In Progress": "To Do",
  Blocked: "In Progress",
  "In Review": "In Progress",
  Done: "In Review",
  Cancelled: "To Do",
};

const statusItem = (from: keyof typeof STATUSES, to: keyof typeof STATUSES): ChangeItem => ({
  field: "status",
  from: STATUSES[from].id,
  fromString: from,
  to: STATUSES[to].id,
  toString: to,
});
const assigneeItem = (from: User | null, to: User | null): ChangeItem => ({
  field: "assignee",
  from: from?.name ?? null,
  fromString: from?.displayName ?? null,
  to: to?.name ?? null,
  toString: to?.displayName ?? null,
});
const priorityItem = (from: string | null, to: string | null): ChangeItem => ({
  field: "priority",
  from: from ? String(PRIORITIES.indexOf(from) + 1) : null,
  fromString: from,
  to: to ? String(PRIORITIES.indexOf(to) + 1) : null,
  toString: to,
});

function addHistory(issue: Issue, author: User, at: number, items: ChangeItem[]) {
  if (!issue.history) issue.history = [];
  issue.history.push({
    id: String(Number(issue.id) * 100 + issue.history.length),
    author,
    created: new Date(at).toISOString().replace("Z", "+0000"),
    items,
  });
}

/**
 * Seeds a few history entries on every other non-epic issue: an old priority
 * change, a status change 1-4 days ago and, on some, a reassignment in the
 * last two days. Derived from the id so the seeded random sequence is untouched.
 */
function seedHistory(issue: Issue, now: number) {
  const n = Number(issue.id);
  if (issue.type === "Epic" || n % 2 !== 0) return;
  const created = new Date(issue.created.replace("+0000", "Z")).getTime();
  const reporter = issue.reporter;
  if (issue.priority && issue.priority !== "Medium")
    addHistory(issue, reporter, created + HOUR, [priorityItem("Medium", issue.priority)]);
  const moved = now - (1 + (n % 4)) * DAY - (n % 7) * HOUR;
  if (moved > created)
    addHistory(issue, issue.assignee ?? reporter, moved, [
      statusItem(PREVIOUS_STATUS[issue.status], issue.status),
    ]);
  const reassigned = now - (n % 3) * DAY - (2 + (n % 5)) * HOUR;
  if (n % 4 === 0 && reassigned > created) {
    const i = USERS.findIndex((u) => u.name === issue.assignee?.name);
    const before = USERS[(i + 1) % USERS.length] ?? null;
    addHistory(issue, reporter, reassigned, [assigneeItem(before, issue.assignee)]);
  }
  issue.history?.sort((a, b) => a.created.localeCompare(b.created));
  const last = issue.history?.at(-1)?.created;
  if (last && last > issue.updated) issue.updated = last;
}

export function generate(total: number, now = Date.now()): Map<string, Issue> {
  seed = 42;
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
    const id = 20000 + issues.size;
    const issue: Issue = {
      id: String(id),
      key: `${project}-${counters[project]}`,
      project,
      type,
      summary: `${pick(VERBS)} ${topic}`,
      description: `Context for the ${topic} work.\n\nh3. Notes\n* check with the platform team\n* see {{INC00${Math.floor(10000 + rand() * 89999)}}}`,
      status: pick(SEEDED_STATUSES),
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
      points: type === "Epic" || type === "Sub-task" ? null : (POINTS[id % POINTS.length] ?? null),
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
  for (const issue of issues.values()) seedHistory(issue, now);
  return issues;
}

const dcUserJson = (u: User | null) =>
  u ? { ...u, key: `JIRAUSER-${u.name}`, active: true, timeZone: "UTC" } : null;
/** Cloud users have an account id and no name or key (D19). */
const cloudUserJson = (u: User | null) =>
  u
    ? {
        accountId: `acc-${u.name}`,
        displayName: u.displayName,
        emailAddress: u.emailAddress,
        active: true,
        timeZone: "UTC",
      }
    : null;
type UserJson = (u: User | null) => Record<string, unknown> | null;
const userJsonFor = (cloud: boolean): UserJson => (cloud ? cloudUserJson : dcUserJson);
/** A user from a request: DC `name`, Cloud `accountId` or `id`. */
const userFrom = (v: unknown): User | null => {
  const o = (v ?? {}) as { name?: string; accountId?: string; id?: string };
  const id = o.name ?? o.accountId ?? o.id;
  return USERS.find((u) => u.name === id || `acc-${u.name}` === id) ?? null;
};
const status = (name: keyof typeof STATUSES) => ({
  id: STATUSES[name].id,
  name,
  statusCategory: { key: STATUSES[name].category, name: STATUSES[name].category },
});
const historyJson = (h: History, userJson: UserJson) => ({
  ...h,
  author: userJson(h.author),
  items: h.items.map((i) => ({ ...i, fieldtype: "jira" })),
});
const commentJson = (c: Comment, userJson: UserJson) => ({
  ...c,
  author: userJson(c.author),
  renderedBody: j2m.jira_to_html(c.body),
});

const linkedIssue = (other: Issue) => ({
  id: other.id,
  key: other.key,
  fields: {
    summary: other.summary,
    status: status(other.status),
    issuetype: { name: other.type, subtask: other.type === "Sub-task" },
  },
});

function issueJson(
  issue: Issue,
  all: Map<string, Issue>,
  embedComments = 2,
  links: readonly MockLink[] = [],
  cloud = false,
) {
  // Cloud links epics through `parent` only (D19).
  const userJson = userJsonFor(cloud);
  const parentKey = issue.parent ?? (cloud ? issue.epic : null);
  const parent = parentKey ? all.get(parentKey) : undefined;
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
            fields: {
              summary: parent.summary,
              issuetype: {
                name: parent.type,
                subtask: false,
                ...(cloud ? { hierarchyLevel: parent.type === "Epic" ? 1 : 0 } : {}),
              },
            },
          }
        : undefined,
      labels: issue.labels,
      components: [],
      duedate: issue.due,
      created: issue.created,
      updated: issue.updated,
      resolutiondate: issue.status === "Done" ? issue.updated : null,
      ...(cloud ? {} : { [EPIC_LINK]: issue.epic, [EPIC_NAME]: issue.epicName }),
      [SPRINT]: issueSprints(issue),
      subtasks: [...all.values()].filter((i) => i.parent === issue.key).map(linkedIssue),
      [STORY_POINTS]: issue.points,
      ...(cloud ? { [ESTIMATE]: issue.estimate ?? null } : {}),
      // Both sides: on `to` the other issue is inward ("is blocked by"), on `from` outward.
      issuelinks: links.flatMap((l) => {
        const type = {
          id: l.type.id,
          name: l.type.name,
          inward: l.type.inward,
          outward: l.type.outward,
        };
        const other = all.get(l.to === issue.key ? l.from : l.to);
        if (!other || (l.to !== issue.key && l.from !== issue.key)) return [];
        const side = l.to === issue.key ? "inwardIssue" : "outwardIssue";
        return [{ id: l.id, type, [side]: linkedIssue(other) }];
      }),
      attachment: [],
      comment: {
        comments: issue.comments.slice(0, embedComments).map((c) => commentJson(c, userJson)),
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

export type MockOptions = {
  /** Cloud shape (D19): Basic auth, /search/jql, account ids, parent epics. */
  cloud?: boolean;
  /** Store a posted Blocks link the other way round, to test the direction check (D45). */
  reversedLinks?: boolean;
  /**
   * Keys the user may not read: `GET /issue/{key}` answers 403 and a search
   * treats them as unknown. Mutable, so a test can hide an issue mid-way.
   */
  hidden?: Set<string>;
  /** Moved or renamed issues, old key to current key: both GET and `key in` find them. */
  moved?: Map<string, string>;
  /** Most issues on one search page, below what was asked (Cloud may do this). */
  searchPageSize?: number;
  /**
   * Whether the user holds DELETE_ISSUES (default true): `GET /mypermissions`
   * says so and `DELETE /issue/{key}` answers 403 without it (D54).
   */
  canDelete?: boolean;
  /** Add the done-category Cancelled status to the workflow (D54). */
  cancelStatus?: boolean;
  /**
   * Keys whose delete Jira refuses with 403 although the user holds the
   * permission (issue security, a workflow that denies deleting).
   */
  undeletable?: Set<string>;
  /** Users who can no longer be assigned: `PUT /assignee` answers 400. */
  unassignable?: Set<string>;
  /**
   * Projects whose create screens have no Story Points field (D55); the edit
   * screen still has it.
   */
  noPointsOnCreate?: Set<string>;
  /**
   * A search index that has not caught up (Cloud's search is eventually
   * consistent): a deleted issue still comes back from searches, as it was when
   * deleted, while `GET /issue/{key}` answers 404 (FR-14.6).
   */
  laggingSearch?: boolean;
};

export function createHandler(issues: Map<string, Issue>, opts: MockOptions = {}) {
  const cloud = !!opts.cloud;
  const userJson = userJsonFor(cloud);
  const touch = (issue: Issue) => {
    issue.updated = new Date().toISOString().replace("Z", "+0000");
  };
  const blocks = LINK_TYPES[0];
  const inWorkflow = (name: StatusName) => opts.cancelStatus || name !== "Cancelled";
  const available = (issue: Issue) =>
    transitionsFrom(issue.status).filter((t) => inWorkflow(t.name));
  let nextLink = 10000;
  const links: MockLink[] = [];
  /** Deleted issues a lagging search index still returns. */
  const indexed = new Map<string, Issue>();
  for (const issue of issues.values())
    for (const l of issue.links)
      links.push({ id: String(nextLink++), type: blocks, from: l.inward, to: issue.key });
  const issueOut = (issue: Issue, embed?: number) => issueJson(issue, issues, embed, links, cloud);

  /** Standard types (not Epic or Sub-task) have the story point fields (D55). */
  const pointed = (type: string | undefined) => type !== "Epic" && type !== "Sub-task";
  /** The story point fields of a screen: Cloud has "Story point estimate" as well (D35). */
  const pointFields = () => [
    ...(cloud ? [{ fieldId: ESTIMATE, name: "Story point estimate", required: false }] : []),
    { fieldId: STORY_POINTS, name: "Story Points", required: false },
  ];
  /** The create screen of a project and type, as createmeta serves it. */
  const createScreen = (project: string, type: string | undefined) => [
    { fieldId: "project", name: "Project", required: true },
    { fieldId: "issuetype", name: "Issue Type", required: true },
    { fieldId: "summary", name: "Summary", required: true },
    { fieldId: "description", name: "Description", required: false },
    { fieldId: "priority", name: "Priority", required: false, hasDefaultValue: true },
    { fieldId: "assignee", name: "Assignee", required: false },
    { fieldId: "duedate", name: "Due Date", required: false },
    { fieldId: "labels", name: "Labels", required: false },
    ...(pointed(type) && !opts.noPointsOnCreate?.has(project) ? pointFields() : []),
    ...(type === "Sub-task" ? [{ fieldId: "parent", name: "Parent", required: true }] : []),
    ...(cloud
      ? pointed(type)
        ? [{ fieldId: "parent", name: "Parent", required: false }]
        : []
      : [
          ...(type === "Epic" ? [{ fieldId: EPIC_NAME, name: "Epic Name", required: true }] : []),
          ...(pointed(type) ? [{ fieldId: EPIC_LINK, name: "Epic Link", required: false }] : []),
        ]),
  ];
  /** An issue's edit screen, as editmeta serves it. */
  const editScreen = (issue: Issue) => {
    const meta = (name: string) => ({ name, required: false, operations: ["set"] });
    return {
      summary: meta("Summary"),
      description: meta("Description"),
      priority: meta("Priority"),
      duedate: meta("Due Date"),
      labels: meta("Labels"),
      ...(pointed(issue.type)
        ? {
            ...(cloud ? { parent: meta("Parent") } : { [EPIC_LINK]: meta("Epic Link") }),
            ...Object.fromEntries(pointFields().map((f) => [f.fieldId, meta(f.name)])),
          }
        : {}),
    };
  };
  /** Jira's 400 for a field the screen does not have, or points that are not a number. */
  const screenProblem = (fields: Record<string, unknown>, screen: readonly string[]) => {
    const allowed = new Set(screen);
    const errors: Record<string, string> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (!allowed.has(k))
        errors[k] = `Field '${k}' cannot be set. It is not on the appropriate screen, or unknown.`;
      else if ((k === STORY_POINTS || k === ESTIMATE) && v !== null && typeof v !== "number")
        errors[k] = "Operation value must be a number.";
    }
    return Object.keys(errors).length ? json({ errorMessages: [], errors }, 400) : null;
  };

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (!req.headers.get("authorization")?.startsWith(cloud ? "Basic " : "Bearer "))
      return new Response("", { status: 401 });
    const agile = /^\/rest\/agile\/1\.0\/board\/(\d+)\/sprint$/.exec(url.pathname);
    if (agile) {
      const boardId = Number(agile[1]);
      if (!BOARDS.some((b) => b.id === boardId))
        return error(
          `Board ${boardId} does not exist or you do not have permission to see it.`,
          404,
        );
      const states = url.searchParams.get("state")?.split(",").filter(Boolean);
      const all = boardSprints(boardId).filter((s) => !states?.length || states.includes(s.state));
      const startAt = Number(url.searchParams.get("startAt") ?? 0);
      const max = Math.min(Number(url.searchParams.get("maxResults") ?? 50), 50);
      const values = all.slice(startAt, startAt + max);
      return json({
        maxResults: max,
        startAt,
        isLast: startAt + values.length >= all.length,
        values: values.map(({ completeDate, ...s }) => ({
          ...s,
          ...(completeDate ? { completeDate } : {}),
          self: `${url.origin}/rest/agile/1.0/sprint/${s.id}`,
        })),
      });
    }
    const moveTo = /^\/rest\/agile\/1\.0\/sprint\/(\d+)\/issue$/.exec(url.pathname);
    if (moveTo && req.method === "POST") {
      const sprintId = Number(moveTo[1]);
      const board = BOARDS.find((b) => boardSprints(b.id).some((s) => s.id === sprintId));
      if (!board) return error(`Sprint with id ${sprintId} does not exist.`, 404);
      const sprint = boardSprints(board.id).find((s) => s.id === sprintId);
      if (sprint?.state === "closed") return error("Cannot move issues into a closed sprint.");
      const body = (await req.json().catch(() => undefined)) as { issues?: unknown } | undefined;
      const keys = Array.isArray(body?.issues) ? body.issues.map(String) : [];
      if (keys.length === 0 || keys.length > 50) return error("Between 1 and 50 issues required.");
      const found = keys.map((k) => issues.get(k));
      const missing = keys.filter((_, i) => !found[i]);
      if (missing.length) return error(`Issues do not exist: ${missing.join(", ")}`);
      for (const issue of found)
        if (issue) {
          issue.movedToSprint = sprintId;
          issue.inBacklog = false;
          touch(issue);
        }
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/rest/agile/1.0/backlog/issue" && req.method === "POST") {
      const body = (await req.json().catch(() => undefined)) as { issues?: unknown } | undefined;
      const keys = Array.isArray(body?.issues) ? body.issues.map(String) : [];
      if (keys.length === 0 || keys.length > 50) return error("Between 1 and 50 issues required.");
      const found = keys.map((k) => issues.get(k));
      const missing = keys.filter((_, i) => !found[i]);
      if (missing.length) return error(`Issues do not exist: ${missing.join(", ")}`);
      for (const issue of found)
        if (issue) {
          issue.movedToSprint = undefined;
          issue.inBacklog = true;
          touch(issue);
        }
      return new Response(null, { status: 204 });
    }
    const path = url.pathname.replace(/^\/rest\/api\/2\//, "");
    const body =
      req.method === "GET"
        ? undefined
        : ((await req.json().catch(() => undefined)) as Record<string, unknown> | undefined);

    if (path === "myself") return json({ ...userJson(USERS[0] ?? null), timeZone: "UTC" });
    if (path === "issueLinkType") return json({ issueLinkTypes: LINK_TYPES });
    if (path === "mypermissions") {
      const key = url.searchParams.get("issueKey") ?? "";
      if (key && !issues.has(key)) return error("Issue Does Not Exist", 404);
      const asked = (url.searchParams.get("permissions") ?? "").split(",").filter(Boolean);
      return json({
        permissions: Object.fromEntries(
          asked.map((p) => [
            p,
            { key: p, havePermission: p === "DELETE_ISSUES" ? opts.canDelete !== false : true },
          ]),
        ),
      });
    }
    if (path === "issueLink" && req.method === "POST") {
      const type = LINK_TYPES.find(
        (t) => t.name === (body?.type as { name?: string } | undefined)?.name,
      );
      const inward = (body?.inwardIssue as { key?: string } | undefined)?.key ?? "";
      const outward = (body?.outwardIssue as { key?: string } | undefined)?.key ?? "";
      if (!type) return error("No issue link type with that name could be found.", 404);
      const a = issues.get(inward);
      const b = issues.get(outward);
      if (!a || !b) return error("Issue Does Not Exist", 404);
      if (a === b) return error("You cannot link an issue to itself.");
      // Meant as "inwardIssue blocks outwardIssue"; some instances keep it reversed.
      const [from, to] = opts.reversedLinks ? [b, a] : [a, b];
      links.push({ id: String(nextLink++), type, from: from.key, to: to.key });
      touch(a);
      touch(b);
      return new Response(null, { status: 201 });
    }
    const linkPath = /^issueLink\/(\d+)$/.exec(path);
    if (linkPath && req.method === "DELETE") {
      const i = links.findIndex((l) => l.id === linkPath[1]);
      if (i < 0) return error("No issue link with id exists.", 404);
      const [gone] = links.splice(i, 1);
      for (const key of [gone?.from, gone?.to]) {
        const issue = key ? issues.get(key) : undefined;
        if (issue) touch(issue);
      }
      return new Response(null, { status: 204 });
    }
    if (path === "field")
      return json([
        {
          id: "summary",
          name: "Summary",
          custom: false,
          schema: { type: "string", system: "summary" },
        },
        // Cloud retired Epic Link and Epic Name for `parent` (D19).
        ...(cloud
          ? []
          : [
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
            ]),
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
        ...(cloud
          ? [
              {
                id: ESTIMATE,
                name: "Story point estimate",
                custom: true,
                schema: {
                  type: "number",
                  custom: "com.pyxis.greenhopper.jira:jsw-story-points",
                  customId: 10016,
                },
              },
            ]
          : []),
        {
          id: STORY_POINTS,
          name: "Story Points",
          custom: true,
          schema: {
            type: "number",
            custom: "com.atlassian.jira.plugin.system.customfieldtypes:float",
            customId: 10106,
          },
        },
      ]);
    if (path === "priority")
      return json(PRIORITIES.map((name, i) => ({ id: String(i + 1), name })));
    if (path === "priority/search")
      return json({
        isLast: true,
        values: PRIORITIES.map((name, i) => ({ id: String(i + 1), name })),
      });
    if (path === "project")
      return json([
        { id: "PAY", key: "PAY", name: "Payments" },
        { id: "OPS", key: "OPS", name: "Operations" },
      ]);
    const projectStatuses = /^project\/([^/]+)\/statuses$/.exec(path);
    if (projectStatuses) {
      const key = decodeURIComponent(projectStatuses[1] ?? "");
      if (!["PAY", "OPS"].includes(key))
        return error(`No project could be found with key '${key}'.`, 404);
      return json(
        ISSUE_TYPES.map((name) => ({
          id: name,
          name,
          subtask: name === "Sub-task",
          statuses: STATUS_NAMES.filter(inWorkflow).map(status),
        })),
      );
    }
    if (path === "user/assignable/search") {
      const q = (url.searchParams.get(cloud ? "query" : "username") ?? "").toLowerCase();
      return json(
        USERS.filter((u) => `${u.name} ${u.displayName}`.toLowerCase().includes(q)).map(userJson),
      );
    }
    const searchPath = cloud ? "search/jql" : "search";
    if (path === (cloud ? "search" : "search/jql")) return error("Gone", 410);
    if (path === searchPath && req.method === "POST") {
      const jql = String(body?.jql ?? "");
      const startAt = cloud ? Number(body?.nextPageToken ?? 0) : Number(body?.startAt ?? 0);
      const max = Math.min(Number(body?.maxResults ?? 50), 100, opts.searchPageSize ?? 100);
      let list = [...issues.values(), ...indexed.values()].filter((i) => !opts.hidden?.has(i.key));
      const parents = /^\(parent in \(([^)]*)\)\)/.exec(jql)?.[1]?.split(/,\s*/);
      if (parents) list = list.filter((i) => i.parent && parents.includes(i.parent));
      // The blocker check reads exactly these keys (D45); a moved key finds the issue's new key.
      const keys = /^key in \(([^)]*)\)$/
        .exec(jql.trim())?.[1]
        ?.split(/,\s*/)
        .map((k) => opts.moved?.get(k) ?? k);
      if (keys) {
        // Cloud has no validateQuery "warn": one unknown key fails the whole search.
        const unknown = keys.find((k) => !issues.has(k) || opts.hidden?.has(k));
        if (cloud && unknown)
          return error(`An issue with key '${unknown}' does not exist for field 'key'.`);
        list = list.filter((i) => keys.includes(i.key));
      }
      const since = /updated >= "([^"]+)"/.exec(jql)?.[1];
      if (since)
        list = list.filter(
          (i) => new Date(i.updated.replace("+0000", "Z")).getTime() >= parseJqlDate(since),
        );
      list.sort((a, b) => a.updated.localeCompare(b.updated));
      const page = list.slice(startAt, startAt + max).map((i) => issueOut(i));
      if (cloud) {
        const last = startAt + page.length >= list.length;
        return json({
          issues: page,
          isLast: last,
          ...(last ? {} : { nextPageToken: String(startAt + page.length) }),
        });
      }
      return json({ startAt, maxResults: max, total: list.length, issues: page });
    }

    const meta = /^issue\/createmeta\/([A-Z]+)\/issuetypes(?:\/(\w[\w-]*))?$/.exec(path);
    if (meta) {
      if (!meta[2]) {
        const types = ISSUE_TYPES.map((t) => ({ id: t, name: t, subtask: t === "Sub-task" }));
        return json(cloud ? { issueTypes: types } : { isLast: true, values: types });
      }
      const fieldsMeta = createScreen(meta[1] ?? "", meta[2]);
      return json(cloud ? { fields: fieldsMeta } : { isLast: true, values: fieldsMeta });
    }
    if (path === "issue" && req.method === "POST") {
      const f = (body?.fields ?? {}) as Record<string, unknown>;
      const project = (f.project as { key?: string } | undefined)?.key ?? "";
      const type = (f.issuetype as { id?: string } | undefined)?.id as Issue["type"] | undefined;
      if (!["PAY", "OPS"].includes(project) || !type)
        return error("project and issuetype are required");
      // Like Jira: a field the create screen does not have is refused.
      const refused = screenProblem(
        f,
        createScreen(project, type).map((x) => x.fieldId),
      );
      if (refused) return refused;
      if (type === "Epic" && !cloud && !f[EPIC_NAME])
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
        assignee: userFrom(f.assignee),
        reporter: USERS[0] as User,
        ...(() => {
          // On Cloud an epic is the parent of a standard issue.
          const parentKey = (f.parent as { key?: string } | undefined)?.key ?? null;
          const epicParent = cloud && parentKey && issues.get(parentKey)?.type === "Epic";
          return {
            epic: epicParent ? parentKey : ((f[EPIC_LINK] as string | undefined) ?? null),
            epicName: (f[EPIC_NAME] as string | undefined) ?? null,
            parent: epicParent ? null : parentKey,
          };
        })(),
        labels: Array.isArray(f.labels) ? f.labels.map(String) : [],
        due: (f.duedate as string | undefined) ?? null,
        created: now,
        updated: now,
        comments: [],
        links: [],
        points: typeof f[STORY_POINTS] === "number" ? (f[STORY_POINTS] as number) : null,
        ...(cloud && typeof f[ESTIMATE] === "number" ? { estimate: f[ESTIMATE] as number } : {}),
        // Like Jira, a new issue is in the backlog until it is moved into a sprint (D57).
        inBacklog: true,
      };
      issues.set(created.key, created);
      return json(
        { id: created.id, key: created.key, self: `/rest/api/2/issue/${created.id}` },
        201,
      );
    }

    const m = /^issue\/([^/]+)(\/.*)?$/.exec(path);
    const asked = decodeURIComponent(m?.[1] ?? "");
    const issue = m ? issues.get(opts.moved?.get(asked) ?? asked) : undefined;
    if (m && issue && opts.hidden?.has(issue.key))
      return error("You do not have the permission to see the specified issue.", 403);
    if (m && !issue) return error("Issue Does Not Exist", 404);
    if (issue) {
      const sub = m?.[2] ?? "";
      if (sub === "" && req.method === "GET") {
        const histories = (issue.history ?? []).map((h) => historyJson(h, userJson));
        const expand = url.searchParams.get("expand")?.split(",") ?? [];
        return json({
          ...issueOut(issue, 1000),
          ...(expand.includes("changelog")
            ? {
                changelog: {
                  startAt: 0,
                  maxResults: histories.length,
                  total: histories.length,
                  histories,
                },
              }
            : {}),
        });
      }
      if (sub === "/changelog" && req.method === "GET") {
        const all = issue.history ?? [];
        const startAt = Number(url.searchParams.get("startAt") ?? 0);
        const max = Math.min(Number(url.searchParams.get("maxResults") ?? 100), 100);
        const values = all.slice(startAt, startAt + max).map((h) => historyJson(h, userJson));
        return json({
          startAt,
          maxResults: max,
          total: all.length,
          isLast: startAt + values.length >= all.length,
          values,
        });
      }
      if (sub === "" && req.method === "PUT") {
        const f = (body?.fields ?? {}) as Record<string, unknown>;
        // Like Jira: a field the edit screen does not have is refused.
        const refused = screenProblem(f, Object.keys(editScreen(issue)));
        if (refused) return refused;
        if (cloud && ESTIMATE in f)
          issue.estimate = typeof f[ESTIMATE] === "number" ? (f[ESTIMATE] as number) : null;
        if ("summary" in f) issue.summary = String(f.summary);
        if ("description" in f) issue.description = (f.description as string | null) ?? null;
        if ("priority" in f) {
          const priority = (f.priority as { name: string } | null)?.name ?? null;
          if (priority !== issue.priority)
            addHistory(issue, USERS[0] as User, Date.now(), [
              priorityItem(issue.priority, priority),
            ]);
          issue.priority = priority;
        }
        if ("duedate" in f) issue.due = (f.duedate as string | null) ?? null;
        if (cloud && "parent" in f) {
          const parentKey = (f.parent as { key?: string } | null)?.key ?? null;
          if (parentKey && issues.get(parentKey)?.type !== "Epic")
            return json({ errorMessages: [], errors: { parent: "Not an epic." } }, 400);
          issue.epic = parentKey;
        }
        if (cloud && Array.isArray((body?.update as { parent?: unknown } | undefined)?.parent))
          issue.epic = null;
        if (STORY_POINTS in f)
          issue.points = typeof f[STORY_POINTS] === "number" ? (f[STORY_POINTS] as number) : null;
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
        const assignee = userFrom(body);
        if (assignee && opts.unassignable?.has(assignee.name))
          return json(
            {
              errorMessages: [],
              errors: { assignee: `User '${assignee.name}' cannot be assigned issues.` },
            },
            400,
          );
        if (assignee?.name !== issue.assignee?.name)
          addHistory(issue, USERS[0] as User, Date.now(), [assigneeItem(issue.assignee, assignee)]);
        issue.assignee = assignee;
        touch(issue);
        return new Response(null, { status: 204 });
      }
      if (sub === "" && req.method === "DELETE") {
        if (opts.canDelete === false)
          return error("You do not have permission to delete issues in this project.", 403);
        if (opts.undeletable?.has(issue.key))
          return error("You do not have permission to delete this issue.", 403);
        const subtasks = [...issues.values()].filter((i) => i.parent === issue.key);
        if (subtasks.length && url.searchParams.get("deleteSubtasks") !== "true")
          return error(
            "The issue has subtasks. Set deleteSubtasks to true to delete them with it.",
          );
        if (opts.laggingSearch) for (const i of [...subtasks, issue]) indexed.set(i.key, i);
        for (const sub of subtasks) issues.delete(sub.key);
        issues.delete(issue.key);
        for (let i = links.length - 1; i >= 0; i--)
          if (links[i]?.from === issue.key || links[i]?.to === issue.key) links.splice(i, 1);
        return new Response(null, { status: 204 });
      }
      const commentPath = /^\/comment\/(\d+)$/.exec(sub);
      if (commentPath) {
        const i = issue.comments.findIndex((c) => c.id === commentPath[1]);
        const found = issue.comments[i];
        if (!found) return error("Can not find a comment for the id.", 404);
        if (req.method === "GET") return json(commentJson(found, userJson));
        if (req.method === "DELETE") {
          issue.comments.splice(i, 1);
          touch(issue);
          return new Response(null, { status: 204 });
        }
      }
      if (sub === "/comment" && req.method === "GET")
        return json({
          startAt: 0,
          maxResults: 1000,
          total: issue.comments.length,
          comments: issue.comments.map((c) => commentJson(c, userJson)),
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
        return json(commentJson(c, userJson), 201);
      }
      if (sub === "/transitions" && req.method === "GET")
        return json({
          transitions: available(issue).map((t) => ({ ...t, to: status(t.name) })),
        });
      if (sub === "/transitions" && req.method === "POST") {
        // Only a transition out of the current status: an id from another is refused.
        const t = available(issue).find(
          (x) => x.id === (body?.transition as { id?: string } | undefined)?.id,
        );
        if (!t)
          return error("It seems that you have tried to perform an illegal workflow operation.");
        addHistory(issue, USERS[0] as User, Date.now(), [statusItem(issue.status, t.name)]);
        issue.status = t.name;
        touch(issue);
        return new Response(null, { status: 204 });
      }
      if (sub === "/editmeta")
        return json({
          fields: editScreen(issue),
        });
      if (sub === "/remotelink" && req.method === "GET") return json(issue.remoteLinks ?? []);
      if (sub === "/remotelink" && req.method === "POST") {
        if (!issue.remoteLinks) issue.remoteLinks = [];
        const links = issue.remoteLinks;
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
        const kept = (issue.remoteLinks ?? []).filter((l) => l.globalId !== globalId);
        if (kept.length === (issue.remoteLinks ?? []).length)
          return error("No remote link with that global id.", 404);
        issue.remoteLinks = kept;
        return new Response(null, { status: 204 });
      }
    }
    return error(`Mock does not implement ${req.method} ${url.pathname}`, 404);
  };
  return Object.assign(handler, { links });
}

if (import.meta.main) {
  const port = flag("port", 8089);
  const issues = generate(flag("issues", 80));
  const cloud = args.includes("--cloud");
  Bun.serve({
    port,
    fetch: createHandler(issues, {
      cloud,
      reversedLinks: args.includes("--reversed-links"),
      canDelete: !args.includes("--no-delete"),
      cancelStatus: args.includes("--cancel-status"),
    }),
  });
  console.log(
    `Mock Jira ${cloud ? "Cloud (any email and token)" : "DC"} on http://localhost:${port} with ${issues.size} issues (tracked epic suggestion: PAY-1)`,
  );
}

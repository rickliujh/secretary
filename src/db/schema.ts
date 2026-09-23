/**
 * Drizzle schema for the local SQLite database (design.md section 4).
 *
 * IDs are ULIDs unless a natural key exists. Timestamps are ISO-8601 strings in
 * UTC. JSON columns are typed here and validated with zod at service boundaries.
 *
 * Constraint of the plugin-sql proxy: rows come back as objects keyed by column
 * name, so a query must not select two columns with the same name (for example
 * `id` from both sides of a join). Use relational queries or `sql` aliases.
 * Raw `db.all(sql...)` returns positional arrays through the proxy; prefer a
 * typed `select` (for FTS: `rowid IN (SELECT rowid FROM ..._fts WHERE ... MATCH ?)`).
 */
import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

const bool = (name: string) => integer(name, { mode: "boolean" });

// ---------------------------------------------------------------------------
// Jira cache
// ---------------------------------------------------------------------------

export const jiraIssues = sqliteTable(
  "jira_issues",
  {
    key: text("key").primaryKey(),
    id: text("id").notNull(),
    projectKey: text("project_key").notNull(),
    issueType: text("issue_type").notNull(),
    isSubtask: bool("is_subtask").notNull().default(false),
    summary: text("summary").notNull(),
    /** Wiki markup as stored in Jira. */
    description: text("description"),
    /** Server-rendered HTML (`renderedFields`), sanitised at display time. */
    descriptionHtml: text("description_html"),
    status: text("status").notNull(),
    statusCategory: text("status_category", { enum: ["new", "indeterminate", "done"] }).notNull(),
    priority: text("priority"),
    /** Jira username, used to match contacts. */
    assignee: text("assignee"),
    assigneeDisplay: text("assignee_display"),
    reporter: text("reporter"),
    reporterDisplay: text("reporter_display"),
    parentKey: text("parent_key"),
    epicKey: text("epic_key"),
    epicName: text("epic_name"),
    labels: text("labels", { mode: "json" }).$type<string[]>().notNull().default([]),
    components: text("components", { mode: "json" }).$type<string[]>().notNull().default([]),
    sprint: text("sprint"),
    dueDate: text("due_date"),
    created: text("created").notNull(),
    updated: text("updated").notNull(),
    resolved: text("resolved"),
    raw: text("raw", { mode: "json" }).$type<unknown>(),
    syncedAt: text("synced_at").notNull(),
    isTrackedEpic: bool("is_tracked_epic").notNull().default(false),
    stale: bool("stale").notNull().default(false),
  },
  (t) => [
    index("jira_issues_project_idx").on(t.projectKey),
    index("jira_issues_parent_idx").on(t.parentKey),
    index("jira_issues_epic_idx").on(t.epicKey),
    index("jira_issues_updated_idx").on(t.updated),
    index("jira_issues_assignee_idx").on(t.assignee),
  ],
);

export const jiraComments = sqliteTable(
  "jira_comments",
  {
    id: text("id").primaryKey(),
    issueKey: text("issue_key").notNull(),
    /** Jira username. */
    author: text("author"),
    authorDisplay: text("author_display"),
    body: text("body").notNull(),
    bodyHtml: text("body_html"),
    created: text("created").notNull(),
    updated: text("updated").notNull(),
  },
  (t) => [index("jira_comments_issue_idx").on(t.issueKey)],
);

// ---------------------------------------------------------------------------
// Secretary-only per-issue state
// ---------------------------------------------------------------------------

export const issueMeta = sqliteTable("issue_meta", {
  issueKey: text("issue_key").primaryKey(),
  priorityOverride: real("priority_override"),
  pinned: bool("pinned").notNull().default(false),
  snoozedUntil: text("snoozed_until"),
  lastViewedAt: text("last_viewed_at"),
  health: text("health"),
});

export const issueNotes = sqliteTable(
  "issue_notes",
  {
    id: text("id").primaryKey(),
    issueKey: text("issue_key").notNull(),
    bodyMd: text("body_md").notNull(),
    sourceUrl: text("source_url"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("issue_notes_issue_idx").on(t.issueKey)],
);

// ---------------------------------------------------------------------------
// Organisational context
// ---------------------------------------------------------------------------

export const teams = sqliteTable("teams", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  function: text("function"),
  contactFor: text("contact_for"),
  channel: text("channel"),
  escalationPath: text("escalation_path"),
  confluenceUrls: text("confluence_urls", { mode: "json" }).$type<string[]>().notNull().default([]),
  notesMd: text("notes_md"),
});

export type CommunicationProfile = {
  tone?: string;
  formality?: string;
  detail?: string;
  responsiveness?: string;
  preferredChannel?: string;
  language?: string;
};

export const people = sqliteTable(
  "people",
  {
    id: text("id").primaryKey(),
    displayName: text("display_name").notNull(),
    jiraUsername: text("jira_username"),
    email: text("email"),
    title: text("title"),
    teamId: text("team_id").references(() => teams.id, { onDelete: "set null" }),
    responsibilities: text("responsibilities"),
    profile: text("profile", { mode: "json" }).$type<CommunicationProfile>().notNull().default({}),
    notesMd: text("notes_md"),
  },
  (t) => [
    index("people_team_idx").on(t.teamId),
    index("people_jira_username_idx").on(t.jiraUsername),
  ],
);

export const contextNotes = sqliteTable(
  "context_notes",
  {
    id: text("id").primaryKey(),
    subjectType: text("subject_type", { enum: ["team", "person", "issue"] }).notNull(),
    subjectId: text("subject_id").notNull(),
    title: text("title").notNull(),
    bodyMd: text("body_md").notNull(),
    sourceUrl: text("source_url"),
    sourceVersion: integer("source_version"),
    importedAt: text("imported_at").notNull(),
  },
  (t) => [index("context_notes_subject_idx").on(t.subjectType, t.subjectId)],
);

// ---------------------------------------------------------------------------
// Dependencies and follow-ups
// ---------------------------------------------------------------------------

export const dependencies = sqliteTable(
  "dependencies",
  {
    id: text("id").primaryKey(),
    issueKey: text("issue_key").notNull(),
    kind: text("kind", { enum: ["person", "team", "incident", "external"] }).notNull(),
    label: text("label").notNull(),
    ownerPersonId: text("owner_person_id").references(() => people.id, { onDelete: "set null" }),
    ownerTeamId: text("owner_team_id").references(() => teams.id, { onDelete: "set null" }),
    externalRef: text("external_ref"),
    externalUrl: text("external_url"),
    status: text("status", { enum: ["open", "waiting", "blocked", "resolved"] })
      .notNull()
      .default("open"),
    requestedAt: text("requested_at"),
    expectedAt: text("expected_at"),
    nextFollowupAt: text("next_followup_at"),
    resolvedAt: text("resolved_at"),
    notesMd: text("notes_md"),
    mirrorRemoteLinkId: text("mirror_remote_link_id"),
  },
  (t) => [
    index("dependencies_issue_idx").on(t.issueKey),
    index("dependencies_status_idx").on(t.status),
  ],
);

export const communications = sqliteTable(
  "communications",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["teams", "email"] }).notNull(),
    intent: text("intent").notNull(),
    recipientPersonId: text("recipient_person_id").references(() => people.id, {
      onDelete: "set null",
    }),
    recipientTeamId: text("recipient_team_id").references(() => teams.id, {
      onDelete: "set null",
    }),
    issueKeys: text("issue_keys", { mode: "json" }).$type<string[]>().notNull().default([]),
    dependencyId: text("dependency_id").references(() => dependencies.id, {
      onDelete: "set null",
    }),
    subject: text("subject"),
    bodyMd: text("body_md").notNull(),
    variant: text("variant", { enum: ["short", "standard"] }),
    status: text("status", { enum: ["draft", "copied", "sent"] })
      .notNull()
      .default("draft"),
    createdAt: text("created_at").notNull(),
    sentAt: text("sent_at"),
  },
  (t) => [index("communications_person_idx").on(t.recipientPersonId)],
);

export const followups = sqliteTable(
  "followups",
  {
    id: text("id").primaryKey(),
    dependencyId: text("dependency_id")
      .notNull()
      .references(() => dependencies.id, { onDelete: "cascade" }),
    at: text("at").notNull(),
    channel: text("channel"),
    summary: text("summary"),
    communicationId: text("communication_id").references(() => communications.id, {
      onDelete: "set null",
    }),
  },
  (t) => [index("followups_dependency_idx").on(t.dependencyId)],
);

// ---------------------------------------------------------------------------
// Intake, proposals, audit
// ---------------------------------------------------------------------------

export const inboxItems = sqliteTable(
  "inbox_items",
  {
    id: text("id").primaryKey(),
    source: text("source", { enum: ["teams", "email", "meeting", "typed", "other"] }).notNull(),
    senderPersonId: text("sender_person_id").references(() => people.id, {
      onDelete: "set null",
    }),
    rawText: text("raw_text").notNull(),
    receivedAt: text("received_at").notNull(),
    status: text("status", { enum: ["new", "triaged", "filed", "dismissed"] })
      .notNull()
      .default("new"),
    triage: text("triage", { mode: "json" }).$type<unknown>(),
  },
  (t) => [index("inbox_items_received_idx").on(t.receivedAt)],
);

export const proposals = sqliteTable(
  "proposals",
  {
    id: text("id").primaryKey(),
    inboxItemId: text("inbox_item_id").references(() => inboxItems.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    payload: text("payload", { mode: "json" }).$type<unknown>().notNull(),
    rationale: text("rationale"),
    confidence: real("confidence"),
    status: text("status", {
      enum: ["pending", "approved", "rejected", "executed", "failed"],
    })
      .notNull()
      .default("pending"),
    editedPayload: text("edited_payload", { mode: "json" }).$type<unknown>(),
    result: text("result", { mode: "json" }).$type<unknown>(),
    createdAt: text("created_at").notNull(),
    decidedAt: text("decided_at"),
  },
  (t) => [
    index("proposals_inbox_idx").on(t.inboxItemId),
    index("proposals_status_idx").on(t.status),
  ],
);

export const actionsLog = sqliteTable(
  "actions_log",
  {
    id: text("id").primaryKey(),
    proposalId: text("proposal_id").references(() => proposals.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    target: text("target"),
    /** Request body with secrets stripped. */
    request: text("request", { mode: "json" }).$type<unknown>(),
    response: text("response", { mode: "json" }).$type<unknown>(),
    ok: bool("ok").notNull(),
    at: text("at").notNull(),
  },
  (t) => [index("actions_log_at_idx").on(t.at)],
);

// ---------------------------------------------------------------------------
// Learning
// ---------------------------------------------------------------------------

export const memories = sqliteTable(
  "memories",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["rule", "fact", "preference", "example"] }).notNull(),
    subjectType: text("subject_type"),
    subjectId: text("subject_id"),
    content: text("content").notNull(),
    exampleInput: text("example_input"),
    exampleBefore: text("example_before", { mode: "json" }).$type<unknown>(),
    exampleAfter: text("example_after", { mode: "json" }).$type<unknown>(),
    source: text("source", { enum: ["user", "inferred"] }).notNull(),
    sourceInboxItemId: text("source_inbox_item_id").references(() => inboxItems.id, {
      onDelete: "set null",
    }),
    confirmed: bool("confirmed").notNull().default(false),
    weight: real("weight").notNull().default(1),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
    useCount: integer("use_count").notNull().default(0),
  },
  (t) => [
    index("memories_kind_idx").on(t.kind),
    index("memories_subject_idx").on(t.subjectType, t.subjectId),
  ],
);

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export const llmCalls = sqliteTable(
  "llm_calls",
  {
    id: text("id").primaryKey(),
    task: text("task").notNull(),
    /** Null for provider tests that bypass tier routing. */
    tier: text("tier", { enum: ["fast", "standard", "strong"] }),
    providerId: text("provider_id").notNull(),
    model: text("model").notNull(),
    escalated: bool("escalated").notNull().default(false),
    repair: bool("repair").notNull().default(false),
    /** Null for calls without a schema (plain text). */
    validationOk: bool("validation_ok"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    durationMs: integer("duration_ms").notNull(),
    ok: bool("ok").notNull(),
    errorKind: text("error_kind"),
    at: text("at").notNull(),
  },
  (t) => [index("llm_calls_at_idx").on(t.at)],
);

export const syncState = sqliteTable("sync_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

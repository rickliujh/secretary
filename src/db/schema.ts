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
import { sql } from "drizzle-orm";
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
    /** Jira user: username on Data Center, account ID on Cloud (D19). Used to match contacts. */
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
    storyPoints: real("story_points"),
    /** The Team field's name (D59); "Team <id>" when Jira returns only an id. */
    team: text("team"),
    /** The team's id as Jira gives it (D59): Cloud's id, Data Center's number as text. */
    teamId: text("team_id"),
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
    /** Jira user: username on Data Center, account ID on Cloud. */
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
  /** The contact who asked for this issue, for a small ask (FR-10.4, D44). */
  requesterPersonId: text("requester_person_id"),
  /** Keys of the issue's open blockers at the last sync; null before the first (D45). */
  openBlockers: text("open_blockers", { mode: "json" }).$type<string[]>(),
  /** When the last open blocker closed (the issue "woke up"); cleared if one reopens (D45). */
  unblockedAt: text("unblocked_at"),
  /** The blocker whose closing woke the issue. */
  unblockedBy: text("unblocked_by"),
  /** When the one OS notification for the wake-up was sent. */
  unblockNotifiedAt: text("unblock_notified_at"),
  /**
   * When the user revoked the create of this ticket and the revoke closed it rather
   * than deleting it (FR-14.6, D54): every thread is told so.
   */
  revokedAt: text("revoked_at"),
});

/**
 * Tickets a revoke deleted (FR-14.6, D54). The row outlives the cached issue, so
 * sync never stores the ticket again, retrieval never offers it from any source,
 * and validation rejects a proposal that targets it, in every thread.
 */
export const deletedIssues = sqliteTable("deleted_issues", {
  issueKey: text("issue_key").primaryKey(),
  /** Jira's id when the cache held it: an issue with another id under the key lifts the row. */
  issueId: text("issue_id"),
  deletedAt: text("deleted_at").notNull(),
  /** The proposal whose revoke deleted it. */
  proposalId: text("proposal_id"),
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
    /**
     * Last day away (YYYY-MM-DD, local), set by hand or from an out-of-office reply
     * (D47). Their waits sleep until the first working day after it. A past date is
     * ignored, not cleared.
     */
    awayUntil: text("away_until"),
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
    /** Confluence page id, for re-import. */
    sourceId: text("source_id"),
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
    /** Jira remote link id when mirrored to the issue (FR-3.4); null when not mirrored. */
    mirrorRemoteLinkId: text("mirror_remote_link_id"),
    /** Local date (YYYY-MM-DD) of the last follow-up reminder, so each fires once a day. */
    notifiedOn: text("notified_on"),
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
    /** What the message should say: the request from the composer, a proposal or a chase (D24). */
    notesMd: text("notes_md"),
    /**
     * Someone else's words the message answers (Phase 25), untrusted: the draft
     * prompt shows them in an untrusted block, apart from the request.
     */
    quoteMd: text("quote_md"),
    /** Generated `{ short, standard }` bodies; null until the first generation. */
    variants: text("variants", { mode: "json" }).$type<{ short: string; standard: string }>(),
    /** Regeneration instructions so far, oldest first. */
    instructions: text("instructions", { mode: "json" }).$type<string[]>().notNull().default([]),
    language: text("language"),
    generatedAt: text("generated_at"),
    subject: text("subject"),
    /** The text the user sends: the chosen variant, possibly edited. */
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
    /** `secretary`: an outcome card the consequence rules made (D61, Phase 25), not input. */
    source: text("source", {
      enum: ["teams", "email", "meeting", "typed", "other", "secretary"],
    }).notNull(),
    senderPersonId: text("sender_person_id").references(() => people.id, {
      onDelete: "set null",
    }),
    rawText: text("raw_text").notNull(),
    receivedAt: text("received_at").notNull(),
    status: text("status", { enum: ["new", "triaged", "filed", "dismissed"] })
      .notNull()
      .default("new"),
    /** One-line triage summary (FR-2.2). */
    summary: text("summary"),
    triage: text("triage", { mode: "json" }).$type<unknown>(),
    /**
     * Set on a work item's own thread (D61): it holds the secretary's questions
     * about that item, not input to classify. Null for every other thread.
     */
    workItemId: text("work_item_id"),
    /**
     * An outcome card's situation (Phase 25): `<rule>:<work_item_id>:<fingerprint
     * of the facts>`, so the same situation is offered once and a changed fact
     * makes a new key. Null for every other thread.
     */
    situationKey: text("situation_key"),
  },
  (t) => [
    index("inbox_items_received_idx").on(t.receivedAt),
    index("inbox_items_work_idx").on(t.workItemId),
    uniqueIndex("inbox_items_situation_idx")
      .on(t.situationKey)
      .where(sql`${t.situationKey} IS NOT NULL`),
  ],
);

/**
 * Messages of an inbox thread (design.md D22). User messages hold typed text
 * (trusted instructions) and pasted blocks (untrusted input); assistant messages
 * mark one triage turn, and the proposals it produced point at them.
 */
export const inboxMessages = sqliteTable(
  "inbox_messages",
  {
    id: text("id").primaryKey(),
    inboxItemId: text("inbox_item_id")
      .notNull()
      .references(() => inboxItems.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    content: text("content", { mode: "json" }).$type<unknown>().notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("inbox_messages_thread_idx").on(t.inboxItemId, t.seq)],
);

/**
 * Atomic items an inbox item was split into, each classified separately
 * (design.md 7.3). The retrieval snapshot makes evaluation replays compare
 * models, not data drift.
 */
export const intakeItems = sqliteTable(
  "intake_items",
  {
    id: text("id").primaryKey(),
    inboxItemId: text("inbox_item_id")
      .notNull()
      .references(() => inboxItems.id, { onDelete: "cascade" }),
    idx: integer("idx").notNull(),
    quote: text("quote").notNull(),
    summary: text("summary"),
    snapshot: text("snapshot", { mode: "json" }).$type<unknown>().notNull(),
    /** Validated model output, before mapping to proposals. */
    output: text("output", { mode: "json" }).$type<unknown>(),
    promptVersion: integer("prompt_version").notNull(),
    tier: text("tier"),
    model: text("model"),
    escalated: bool("escalated").notNull().default(false),
    lowConfidence: bool("low_confidence").notNull().default(false),
    error: text("error"),
  },
  (t) => [index("intake_items_inbox_idx").on(t.inboxItemId)],
);

export const proposals = sqliteTable(
  "proposals",
  {
    id: text("id").primaryKey(),
    inboxItemId: text("inbox_item_id").references(() => inboxItems.id, { onDelete: "cascade" }),
    intakeItemId: text("intake_item_id").references(() => intakeItems.id, { onDelete: "cascade" }),
    /** The assistant turn that proposed it (D22); null for rows made before threads. */
    messageId: text("message_id").references(() => inboxMessages.id, { onDelete: "set null" }),
    /** Execution order within the inbox item; `$new` references point backwards. */
    seq: integer("seq").notNull().default(0),
    kind: text("kind").notNull(),
    payload: text("payload", { mode: "json" }).$type<unknown>().notNull(),
    rationale: text("rationale"),
    /** Quoted span of the input that supports the proposal. */
    evidence: text("evidence"),
    confidence: real("confidence"),
    status: text("status", {
      // superseded: replaced by a later turn of the thread before it was decided (D22).
      // revoked: executed, then undone by the user (D54).
      enum: ["pending", "approved", "rejected", "executed", "failed", "superseded", "revoked"],
    })
      .notNull()
      .default("pending"),
    editedPayload: text("edited_payload", { mode: "json" }).$type<unknown>(),
    result: text("result", { mode: "json" }).$type<unknown>(),
    createdAt: text("created_at").notNull(),
    decidedAt: text("decided_at"),
    /**
     * A step of an outcome card (Phase 25): the card's inbox item id, and the
     * rule that made it. Steps run in `seq` order through `approveBundle`.
     */
    bundleId: text("bundle_id"),
    bundleKind: text("bundle_kind"),
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
// The work model (FR-19, D61)
// ---------------------------------------------------------------------------

/** A piece of work in flight: tickets serving one goal, with the secretary's state. */
export const workItems = sqliteTable(
  "work_items",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** Who named it: code (epic or ticket), the state call (its goal) or the user (a rename). */
    nameBy: text("name_by", { enum: ["code", "state", "user"] })
      .notNull()
      .default("code"),
    goal: text("goal"),
    status: text("status", { enum: ["active", "done", "dismissed"] })
      .notNull()
      .default("active"),
    /** The state in D61's shape (`services/work/schema.ts`); null before the first update. */
    state: text("state", { mode: "json" }).$type<unknown>(),
    stateVersion: integer("state_version").notNull().default(0),
    stateUpdatedAt: text("state_updated_at"),
    /** The status note the user wrote; kept word for word while `note_edited_at` is set. */
    note: text("note"),
    /** When the user edited the status note; cleared when a fact the note names changes. */
    noteEditedAt: text("note_edited_at"),
    /** The facts the edited note names, as they were when it was written. */
    noteFacts: text("note_facts", { mode: "json" }).$type<unknown>(),
    /** The last state update failed validation: the previous state stands, the user should look. */
    needsLook: bool("needs_look").notNull().default(false),
    /** The item the user said they are on; at most one. */
    current: bool("current").notNull().default(false),
    /** The item this one was merged into (status dismissed). */
    mergedInto: text("merged_into"),
    createdAt: text("created_at").notNull(),
    closedAt: text("closed_at"),
  },
  (t) => [index("work_items_status_idx").on(t.status)],
);

/** Which tickets belong to which work item: each ticket in one item at most. */
export const workItemIssues = sqliteTable(
  "work_item_issues",
  {
    issueKey: text("issue_key").primaryKey(),
    workItemId: text("work_item_id")
      .notNull()
      .references(() => workItems.id, { onDelete: "cascade" }),
    /** primary: the user's own active ticket; related: a blocker or a ticket it waits on. */
    role: text("role", { enum: ["primary", "related"] })
      .notNull()
      .default("primary"),
    addedBy: text("added_by", { enum: ["code", "user", "answer"] })
      .notNull()
      .default("code"),
    addedAt: text("added_at").notNull(),
  },
  (t) => [index("work_item_issues_item_idx").on(t.workItemId)],
);

/** Everything that touched a work item, in order (FR-19.2). */
export const workEvents = sqliteTable(
  "work_events",
  {
    id: text("id").primaryKey(),
    /** Null until attached, and for an event that belongs to no item. */
    workItemId: text("work_item_id").references(() => workItems.id, { onDelete: "set null" }),
    kind: text("kind").notNull(),
    at: text("at").notNull(),
    /** "me", "contact:<id>", "jira:<user>" or "sync". */
    actor: text("actor").notNull(),
    issueKey: text("issue_key"),
    /** The proposal, intake item, dependency, comment or communication it came from. */
    ref: text("ref"),
    summary: text("summary").notNull(),
    data: text("data", { mode: "json" }).$type<unknown>(),
    /** How it was attached; null while it waits. `none`: it belongs to no item. */
    attachedBy: text("attached_by", {
      enum: ["code", "model", "user", "answer", "unsure", "none"],
    }),
    /** Folded into the item's state, or never to be (views, unsure attachments). */
    applied: bool("applied").notNull().default(false),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("work_events_item_idx").on(t.workItemId, t.at),
    index("work_events_pending_idx").on(t.attachedBy, t.applied),
    index("work_events_issue_idx").on(t.issueKey),
  ],
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

/** Chat page conversations (design.md D28); `messages` are AI SDK UI messages. */
export const chatConversations = sqliteTable(
  "chat_conversations",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    messages: text("messages", { mode: "json" }).$type<unknown[]>().notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("chat_conversations_updated_idx").on(t.updatedAt)],
);

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

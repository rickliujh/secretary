# Secretary: Feature Requirements

Status: approved for implementation. Date: 2026-09-23.
Owner: Rick Liu. Executor: Claude Opus 5.5 (see `implementation-plan.md`).

## 1. Vision

A personal desktop AI secretary for one knowledge worker whose work is tracked in
Jira Data Center as Epics, Stories and Tasks. The secretary keeps the tracker up to
date from messy inputs (pasted messages, spoken-style descriptions), tracks external
dependencies (people, teams, ServiceNow incidents), holds organisational context
(teams, people, personalities, Confluence pages), tells the user what matters most
right now, drafts outbound Teams messages and emails in the right tone for the
recipient, and improves from the user's corrections over time.

Principles, in priority order:

1. **Human in the loop for every outward write.** The secretary proposes; the user
   approves. No Jira write, no memory write inferred from content, without an
   explicit approve action in the UI. Reading and local drafting need no approval.
2. **Jira is the source of truth for tickets.** The local database is a cache plus
   a home for secretary-only data (dependencies, notes, people, memories).
3. **Local first, private.** All data lives on the user's machine. Secrets live in
   the OS keychain. Only the configured LLM endpoints, Jira and Confluence hosts are
   contacted.
4. **Mature libraries over handrolled code.** See `design.md` for the stack.
5. **Deterministic first, model second.** Code does everything it can do reliably:
   reference extraction, candidate retrieval, ranking, payload building,
   validation. The model only makes judgments code cannot, in narrow, schema-bound
   steps. Behaviour should degrade gracefully, not change character, when the
   configured model changes.

## 2. Users and environment

- Single user, desktop (Linux first, Windows and macOS builds expected to work).
- Jira Data Center (self-hosted, REST API v2, Personal Access Token as Bearer) or Jira Cloud
  (`*.atlassian.net`, account email and API token as Basic auth). Added 2026-09-25, design.md D19.
- Confluence Data Center (PAT) or Confluence Cloud (email and API token). Read only.
- ServiceNow: incidents referenced by number and URL. No API access in v1.
- Microsoft Teams and Outlook are used for communication but are **not**
  integrated in v1. The secretary produces text; the user pastes it.
- LLM access: any OpenAI-compatible chat-completions endpoint and any
  Anthropic-compatible Messages endpoint, user-configured (base URL, key, model).

## 3. Glossary

| Term | Meaning |
|---|---|
| Ticket | A Jira issue of type Epic, Story, Task, Sub-task or Bug |
| Inbox item | A piece of raw input the user gives the secretary (pasted message, typed update) |
| Proposal | A single concrete action the secretary suggests (create issue, comment, link dependency, remember fact, ...) awaiting approval |
| Dependency | Something a ticket waits on that is outside the user's control: a person, a team, a ServiceNow incident, or an external item |
| Contact | A person record with title, team, contact details and communication profile |
| Memory | A stored rule, fact, preference or correction example the secretary uses in later reasoning |
| Brief | The dashboard's generated summary of what matters now |

## 4. Functional requirements

Each requirement has an ID, a description and acceptance criteria (AC). "Must" is v1
scope; "Should" is v1 if time permits; "Could" is later.

### FR-1 Connect and sync Jira

- FR-1.1 (Must) Configure Jira base URL and PAT; test connection shows the current
  user's display name.
- FR-1.2 (Must) Configure a sync scope: a JQL string (default provided) plus a list of
  tracked Epic keys. Children of tracked epics are always synced.
- FR-1.3 (Must) Incremental sync on demand and on a timer while the app is open
  (default every 10 minutes). Sync stores issue fields listed in `design.md`.
- FR-1.4 (Must) Discover the Epic Link, Epic Name and Sprint custom field IDs
  automatically from `/rest/api/2/field`, with manual override in settings.
- FR-1.5 (Must) Browse tickets as a tree: Epic -> Story/Task -> Sub-task, with filters
  by status category, assignee, project, and free text.
- FR-1.6 (Must) Ticket detail view: fields, description (wiki markup rendered),
  comments, links, attachments list, dependencies, secretary notes.
- FR-1.7 (Must) Manual actions from the detail view: add comment, transition status,
  edit summary/description/priority/assignee/due date, set parent or epic link.
- AC: after configuring against a real Jira DC instance, all issues matching scope
  appear within one sync; editing a field in the app is visible in Jira within seconds.

### FR-2 Intake: turn messy input into tracker actions

- FR-2.1 (Must) An intake box accepts pasted text (Teams message, email, meeting
  notes) or a typed description. Optional fields: who it came from (contact picker),
  source (Teams/email/meeting/other).
- FR-2.2 (Must) The secretary produces a **triage result**: a one-line summary, and a
  list of typed proposals. Proposal kinds in v1:
  - create issue (epic/story/task/sub-task/bug) with parent or epic link
  - update issue fields
  - add comment to issue
  - transition issue
  - link dependency (person/team/incident/external) to issue
  - update contact or team profile with a learned fact
  - remember a rule or preference
  - draft a message (hands off to FR-6)
  - "needs clarification" question to the user
- FR-2.3 (Must) Each proposal card shows the target, the concrete payload, the
  rationale, a confidence indicator and edit/approve/reject buttons. Approve-all is
  available. Edits before approval are recorded for learning (FR-7).
- FR-2.4 (Must) Approved proposals execute against Jira and the local DB, in order,
  with per-proposal success/failure shown; failures do not block the rest.
- FR-2.5 (Must) The secretary finds the right existing ticket by: explicit keys in
  the text, full-text match on summaries/descriptions in the cache, recent activity,
  and memories. When unsure it asks rather than guesses.
- FR-2.6 (Should) Inbox history: every intake is kept with its triage and what was
  approved, searchable.
- FR-2.7 (Could) Bulk intake: paste a long chat log and split into several items.
- AC: given 20 representative inputs from the user, at least 16 produce proposals the
  user accepts without edit or with minor edits; zero writes happen without approval.

### FR-3 Dependencies and follow-ups

- FR-3.1 (Must) A dependency has: kind (person/team/incident/external), owner
  (contact or team), external reference (e.g. INC number) and URL, status
  (open/waiting/blocked/resolved), requested date, expected date, next follow-up
  date, notes and a timeline of follow-ups.
- FR-3.2 (Must) Dependencies can be created from intake proposals or manually from
  a ticket.
- FR-3.3 (Must) A "Waiting on" list shows all open dependencies sorted by overdue
  days, grouped by owner, with a one-click "draft a chase message" (FR-6).
- FR-3.4 (Should) Mirror a dependency as a Jira remote link on the issue (opt-in per
  dependency) so teammates see it in Jira.
- FR-3.5 (Should) OS notifications when a follow-up date arrives while the app runs.
- AC: a dependency created today with expected date yesterday shows as overdue on the
  dashboard and in the waiting list.

### FR-4 Organisational context

- FR-4.1 (Must) Teams: name, function, what to contact them for, primary channel,
  escalation path, Confluence links, notes, members.
- FR-4.2 (Must) Contacts: display name, Jira username, email, title, team,
  responsibilities, personality and communication profile (tone, formality, detail
  level, responsiveness, preferred channel, language), free notes.
- FR-4.3 (Must) The user can add or edit all of this directly. The secretary can also
  propose profile updates from intake text (approved like any proposal).
- FR-4.4 (Must) Confluence: configure base URL and PAT; search pages with CQL or free
  text; open a page in the browser; **import** a page as a context note attached to a
  team, contact or ticket (stored as Markdown, with source URL and version).
- FR-4.5 (Should) Context notes are included in LLM retrieval for intake, briefs and
  message drafting.
- FR-4.6 (Could) Import/export of teams and contacts as JSON for backup.
- AC: a contact with "prefers short bullet points, formal" produces visibly different
  drafts than one with "casual, likes context".

### FR-5 Dashboard and priorities

- FR-5.1 (Must) Dashboard sections: Top focus (ranked tickets), Waiting on me
  (assigned to me, unresolved, recently updated by others, or mentioned), I am
  waiting on (overdue dependencies), At risk (stale or blocked), Due soon, Pending
  inbox proposals, Epic health rollup (per tracked epic: done/in progress/todo
  counts and blocked count).
- FR-5.2 (Must) Ranking is a deterministic, explainable score (Jira priority, due
  proximity, blocked/blocking, staleness, dependency overdue, pin/override). Each
  ranked card can show "why here".
- FR-5.3 (Must) The user can pin, snooze, or override priority on a ticket locally
  without touching Jira.
- FR-5.4 (Should) A generated **daily brief** in prose: what changed since last look,
  what to do first, who to chase. Generated on demand, cached until data changes.
- FR-5.5 (Could) Trend charts (throughput, open dependency count over time).
- AC: dashboard renders in under 1 second from the local cache with 2,000 issues.

### FR-6 Communication drafting

- FR-6.1 (Must) Draft a Teams message or an email (subject + body) given: intent
  (chase, status update, request, escalation, FYI, thank-you), recipient (contact or
  team), related tickets and dependencies, extra notes.
- FR-6.2 (Must) Tone adapts to the recipient's communication profile and team
  function; content is grounded in the linked tickets and dependency history.
- FR-6.3 (Must) Output offers short and standard variants; the user can edit and
  regenerate with instructions; copy to clipboard; mark as "sent" which logs a
  follow-up on the linked dependency.
- FR-6.4 (Should) Output language setting (default English) and a per-contact
  language override.
- FR-6.5 (Should) Recent messages to the same recipient are shown for continuity and
  passed to the model as style context.
- AC: a chase draft for an overdue incident dependency names the incident number,
  the ask, and the date first requested.

### FR-7 Learning and memory

- FR-7.1 (Must) Explicit memory: the user can add rules ("anything about the billing
  migration goes under EPIC-12"), facts and preferences, and view/edit/delete them.
- FR-7.2 (Must) Correction capture: when the user edits or rejects a proposal, the
  before/after pair is stored as a correction example with the input excerpt.
- FR-7.3 (Must) Memories and recent correction examples are retrieved into the
  intake, brief and drafting prompts, within a token budget, ranked by relevance,
  weight and recency.
- FR-7.4 (Should) Consolidation: on request, the secretary reviews correction
  examples and proposes generalised rules; the user approves them into memory.
- FR-7.5 (Should) Provenance on every memory: user-written, or inferred (from which
  inbox item), confirmed or not.
- AC: after correcting the same classification twice, the third similar input is
  classified correctly without edit.

### FR-8 Ask the secretary (chat)

- FR-8.1 (Should) A chat panel that answers questions over local data (tickets,
  dependencies, contacts, notes) and Confluence search using tool calls, and can
  turn its answer into proposals. Writes still go through the proposal flow.

### FR-9 Settings and operations

- FR-9.1 (Must) LLM providers: add multiple named providers (kind: anthropic or
  openai-compatible; base URL; API key; optional extra headers). Test button.
- FR-9.2 (Must) Model tiers: three slots, **fast**, **standard**, **strong**, each
  bound to a provider and model. Unconfigured tiers fall back to the next stronger
  configured tier, so a single model works.
- FR-9.3 (Must) Task routing: every LLM task type has a default tier (table in
  `design.md` section 7.1) that the user can override per task in settings, plus an
  **escalation** toggle: when a task's output fails validation or its confidence is
  below threshold, retry once on the next stronger tier before asking the user.
- FR-9.4 (Should) Evaluation replay: pick a task type and a model, replay stored
  inbox items whose proposals the user approved, and report how often the new
  output matches the approved result. Lets the user judge whether a cheaper model
  is good enough for that task.
- FR-9.5 (Must) Show per-call token usage by tier and a running session total.
- FR-9.6 (Must) Data location shown; export and import of the full local database;
  "reset cache" that clears synced Jira data but keeps secretary data.
- FR-9.7 (Must) Secrets never appear in logs, exports or the UI after entry.

## 5. Non-functional requirements

- NFR-1 Works offline for browsing cached data, drafting from cache and editing
  context. Jira writes queue with a clear "pending" state only if trivial; otherwise
  fail fast with a retry button. v1: fail fast.
- NFR-2 Startup under 2 seconds on a typical laptop; UI stays responsive during sync
  and LLM calls (async, cancellable).
- NFR-3 All outbound HTTP restricted by Tauri capabilities to configured hosts.
- NFR-4 Pasted content is untrusted. Prompts label it as data. Proposals require
  approval, which is the primary defence against prompt injection.
- NFR-5 Unit tests for scoring, retrieval, Jira payload building and proposal
  execution. Contract tests for Jira and Confluence clients against recorded fixtures.
- NFR-6 Accessibility: keyboard navigation for approve/reject and the tree; shadcn
  defaults kept.
- NFR-7 Model robustness. The following never depend on a model: reference
  extraction, candidate retrieval, priority ranking, Jira payload building, output
  validation, sync, dependency and follow-up logic. Every model output is validated
  against a schema and against the candidate set the code supplied (an issue key
  must be one the retrieval step offered or a new-issue placeholder). Switching the
  standard tier from a strong model to a mid-tier model must not change which
  actions are possible, only how often the user needs to edit a proposal.

## 6. Out of scope for v1

- Sending Teams messages or emails automatically; reading mail or chats.
- ServiceNow API integration.
- Multi-user or server deployment.
- Jira Cloud support (design keeps a provider seam, but no implementation).
- Voice input.

## 7. Assumptions to confirm with the user during Phase 0

- Jira DC version is 8.14 or newer (PAT support). The thin REST v2 client
  (`design.md` D11) works on all such versions.
- Epic-to-story relation uses the "Epic Link" custom field (classic) rather than
  `parent`. The sync handles both.
- Confluence DC 7.9 or newer (PAT support).
- The user's Jira account can create issues in the target projects.
- Default output language English; UI English only.

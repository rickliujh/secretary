# Changelog

## Phase 0: Scaffold and settings (2026-09-23)

Built
- Tauri 2 + React 19 + Vite scaffold; Tailwind v4 and shadcn/ui (radix-nova preset);
  TanStack Router (file routes) and Query; biome for lint and format.
- Tauri plugins from design.md section 1; keychain commands `secret_get/set/delete` on
  the `keyring` crate (v4); permissive http scope for development (tighten in Phase 8);
  CSP set, with a relaxed `devCsp` for Vite.
- Effect services, each with live and test layers and tests: `Db` (drizzle sqlite-proxy
  over plugin-sql, bundled migrations, sql.js in tests), `Secrets`, `Settings`
  (plugin-store + zod), `Fetcher` (plugin-http fetch), `Llm`, `JiraClient` and
  `ConfluenceClient` (connection tests only).
- `Llm`: provider registry for Anthropic- and OpenAI-compatible endpoints, three tiers,
  per-task routing with overrides, validate -> repair -> escalate for object calls,
  `llm_calls` accounting, tier and provider test calls.
- UI: sidebar shell with placeholder pages, Ctrl+K command palette, theme toggle,
  session token indicator, startup gate that surfaces database errors, and settings
  tabs for General, Providers, Models (tiers and task routing), Jira, Confluence,
  Usage and Data.

Decisions and defaults
- D11: jira.js v6 is Cloud-only, so the Jira client is a thin `ky` + zod client.
- D12: provider extra headers are stored in the keychain; settings hold header names only.
- D13: an unconfigured tier resolves to the next stronger tier, then to weaker ones.
- `llm_calls` columns follow design.md 7.1 (`task`, `tier`, `escalated`, `repair`,
  `validation_ok`, `error_kind`); `tier` is null for provider-level tests.
- Anthropic tier suggestions are `claude-haiku-4-5` / `claude-sonnet-5` /
  `claude-opus-5-5` (the latest Opus replaces `claude-opus-5`).
- Thinking and effort are opt-in per provider ("Provider default" sends neither),
  because compatible proxies may reject them.
- Escalation on an escalated attempt gets no second repair: one call on the next
  stronger tier, then a schema error the caller turns into a clarification.
- Default task timeouts: 45 to 180 seconds depending on the task (`TASK_DEFAULTS`).
  One transport retry via the AI SDK and ky.
- The database lives in `appDataDir` (absolute path passed to plugin-sql, which would
  otherwise use the config dir). plugin-sql pools connections, so each migration runs
  as a single `BEGIN ... COMMIT` script; app code should not rely on multi-call
  transactions.
- `tauri-plugin-http` is pinned to `~2.6` to match the latest npm package (2.6.1).
- next-themes' pre-hydration script is rendered as an inert data block; it is only
  useful for SSR and would be blocked by the CSP.

Known limits
- The proxy maps row objects to arrays, so one query must not select two columns
  with the same name (noted in `src/db/schema.ts`).
- The main bundle is about 1.3 MB minified; code splitting is left to Phase 8.
- The production CSP has not been exercised in a release build yet (Phase 8).

## Phase 1: Jira sync and ticket browser (2026-09-24)

Built
- `JiraClient` for the design.md section 5 endpoints (thin `ky` + zod client, D11), with
  Jira's `{errorMessages, errors}` surfaced in error messages.
- Field discovery for Epic Link, Epic Name and Sprint, with overrides in settings.
- `Sync`: scope JQL plus tracked epics, incremental from a watermark formatted in the
  Jira user's time zone, paging, bulk upserts, comments (embedded, with the rest
  fetched), a sub-task pass for stories under tracked epics, weekly full resync with
  stale marking, live status, and a timer while the app runs.
- FTS5 index over issues with triggers (migration `0002_jira_fts`).
- `Executor` as the only write path: comment, transition, edit fields, assign, set epic.
  Payloads are built in `executor/jira-mapping.ts`. Every write is recorded in
  `actions_log` with secrets redacted and followed by a re-fetch of the issue.
- Markdown <-> wiki markup (`src/lib/wiki.ts`, jira2md with a pre-pass for dash lists
  and GFM tables) and sanitised display of Jira's rendered HTML (`src/lib/html.ts`).
- Tickets page: virtualised Epic -> Story -> Sub-task tree (TanStack Table v9 + Virtual),
  search, filters by status category, assignee (including "Me"), project and stale;
  detail sheet with fields, description, comments, links and attachments, and actions.
- Header sync indicator, Jira sync settings (scope, custom fields, sync now, full
  resync), ticket search in the Ctrl+K palette.
- `bun run mock:jira`: a fake Jira DC with generated data for UI work without an
  instance, also used by an end-to-end test of client, sync and executor.

Decisions and defaults
- D14: display Jira's server-rendered HTML; jira2md only for conversions. Description
  edits are in raw wiki markup to avoid lossy round trips; comments are written in
  Markdown and converted.
- D15: tests use `bun:sqlite` (FTS5) instead of sql.js.
- Search uses `validateQuery: "warn"` so one bad tracked-epic key does not fail a sync.
- Page size 100; sub-task pass in chunks of 100 parent keys; watermark overlap 5 minutes.
- Jira timestamps are stored as UTC ISO strings (Jira's `+0100` offsets are normalised
  first, because WebKit's Date parser rejects them).
- `jira_issues` stores usernames (`assignee`, `reporter`) for contact matching in
  Phase 2 and display names alongside.
- Images in rendered HTML become links: they need the Jira session and the CSP blocks
  remote images.
- The Jira username is stored at sync time so the "Me" filter works offline.

Not verified yet
- Nothing has run against a real Jira DC instance. The client, sync and executor run
  end to end against the mock server and recorded-style fixtures only.
- The ticket UI has not been exercised in the running app; it typechecks, lints and
  builds.

## Phase 2: Organisational context (2026-09-24)

Built
- Teams and People pages with create, edit and delete, detail sheets, and a structured
  communication profile (formality, detail, responsiveness, preferred channel,
  language, tone) plus free Markdown notes.
- Contact matching: Jira usernames match contacts case-insensitively at display time,
  so assignees and reporters in the ticket view link to contacts, or offer "Add as
  contact" prefilled from Jira. The People page suggests Jira users from the cache who
  are not contacts yet, most frequent first.
- `ConfluenceClient` search and page fetch; search dialog with free text, space filter
  and a raw CQL toggle; import as a Markdown context note on a team, person or ticket;
  re-import updates in place; open in the browser.
- Context notes (imported pages and free notes) on team, person and ticket detail, with
  an FTS5 index (`0003_context_notes_fts`) ready for Phase 3 retrieval.
- JSON backup: export and import of teams, people and their notes, validated with zod
  and idempotent (upsert by id). Secrets are never part of it.
- `bun run mock:confluence`: a fake Confluence DC with team pages and runbooks in real
  storage format, also used by an end-to-end import test.
- People and teams in the Ctrl+K palette; shared Markdown renderer (react-markdown +
  remark-gfm, no raw HTML).

Decisions and defaults
- Free-text Confluence search uses `text ~` and `title ~`, not `siteSearch ~`.
- Storage-format conversion uses turndown with the maintained Joplin GFM plugin and a
  tested pre-pass (design.md section 6). Images become `(image: name)` placeholders.
- `context_notes.source_id` added so imported pages can be re-imported.
- Deleting a team keeps its members as contacts without a team and deletes the team's
  notes; deleting a person deletes their notes.
- Directory edits are the user's own local writes, so they do not go through proposals.
  Profile updates inferred from pasted text arrive as proposals in Phase 3.
- `fs:allow-read-text-file` and `fs:allow-write-text-file` added for the backup files
  chosen in the save and open dialogs.

Not verified yet
- Nothing has run against a real Confluence. Search and import run end to end against
  the mock and fixtures only.
- The new pages have not been exercised in the running app; they typecheck, lint and
  build.

## Phase 3: Intake, proposals, execution (2026-09-24)

Built
- Deterministic preprocessing: whitespace normalisation, removal of quoted email history
  and signatures, and extraction of Jira keys (also from browse URLs), ServiceNow numbers
  (INC, RITM, REQ, CHG, PRB, SCTASK), emails, URLs and mentioned contacts (full name,
  email, @username, unique first name).
- `Retrieval` service: candidates from explicit mentions, bm25 full-text search, the
  sender's issues, recent views and updates, tracked epics and the candidates' epics;
  project issue types and statuses, priorities and Jira users from the cache; relevant
  teams and people; open dependencies; confirmed memories and correction examples
  ranked by overlap, weight and recency; context notes. Every block has a token budget.
- Prompts: `segment_input` (verbatim quotes, checked in code) and `classify_item` with a
  per-item output schema whose targets, projects, issue types, statuses, people, teams
  and users are enums from the candidates. Code validation covers `$new` refs, sub-task
  parents, epic types, dates, statuses already set, unknown users and incident
  references; failures go through repair, escalation, then a question.
- `Intake` service: persists the inbox item first, splits long input, snapshots
  retrieval per item, classifies, merges `$new` refs across items, drops duplicates,
  and adds a question when the model asks one or stays below the confidence threshold.
  Re-triage, and answering a question, re-run it.
- Canonical proposal payloads for all FR-2.2 kinds; `Executor.runProposal` for each
  kind (Jira create with create-metadata checks, comment, transition by target status,
  field updates and assignment; local dependency, contact, team, memory and draft-request
  writes), all recorded in `actions_log`.
- `Proposals` service: approve (with optional edits), reject, approve all in order,
  dismiss, and correction capture into `example` memories (FR-7.2).
- Inbox page: intake box (source, sender picker, cancel), history with search and
  pending/failed badges, proposal cards per kind with rationale, evidence and
  confidence, edit forms per kind, approve/edit/reject with a/e/r on the focused card,
  approve all, re-triage, dismiss, and clarification cards. Quick intake on the
  dashboard and a pending count on the sidebar.
- Eval set: eight sanitised cases (including a prompt injection) with a scorer; a live
  runner behind `SECRETARY_EVAL_*` variables that can also compare a fast model with the
  standard one. `mock:jira` now supports create metadata and issue creation.

Decisions and defaults (design.md 7.3 notes, D16, D17)
- Deterministic ranking replaces the optional `rerank_candidates` call.
- Segmentation that fails validation falls back to classifying the whole text.
- Correction examples use `subject_type = proposal_kind` and store the item quote.
- Approved `remember` proposals are stored as confirmed, `inferred` memories.
- Approved `draft_message` proposals create a `communications` row in `draft` status
  whose body holds the notes; the Phase 6 composer writes the message.
- Project issue types and statuses offered to the model come from the local cache;
  Jira's create metadata is checked at execution.

Not verified yet
- No real model has run: every model call in tests is scripted. The Phase 3 checklist
  needs your sample messages and an LLM endpoint (Settings > Providers and Models). To
  run the eval: set the `SECRETARY_EVAL_*` variables described in
  `src/test/eval/eval.live.test.ts` and run `bun test src/test/eval`.
- The Inbox UI has not been exercised in the running app.

## Phase 4: Dependencies and follow-ups (2026-09-25)

Built
- Dependency service: create, edit, status changes, delete; list joined with the issue,
  the owner and follow-up history; pure timing logic (days overdue, follow-up due,
  working-day arithmetic) and grouping by owner, most overdue first.
- Waiting on page: groups by owner with overdue and to-chase counts, filters for
  "needs action today" and resolved items, and a detail sheet with the follow-up
  timeline, log follow-up, draft a chase, resolve or reopen, edit, delete, and a Jira
  mirror switch.
- "Waiting on" tab on the ticket detail with an add form; approved `link_dependency`
  proposals land in the same list.
- Logging a follow-up records it in the timeline, moves an open dependency to waiting
  and schedules the next chase (default 3 working days, set in Settings > General).
- OS notifications for due follow-ups while the app runs, at most once a day per
  dependency (switch in Settings > General).
- Jira mirroring (FR-3.4, D18): `upsert_remote_link` and `delete_remote_link` Executor
  actions; mirrored dependencies update their remote link when edited or resolved.
- "Draft a chase" saves a chase request (incident number, the ask, first request date)
  for the Phase 6 composer.
- `mock:jira` supports remote links; an end-to-end test mirrors, resolves and removes
  one over HTTP.

Decisions and defaults
- Expected and follow-up dates are local calendar dates; overdue days compare with
  today's local date.
- Remote-link writes skip the issue re-fetch because they do not change cached fields.

Not verified yet
- Remote links in a real Jira DC, and OS notifications on the desktop.
- The Waiting page in the running app.

## Phase 5: Dashboard and scoring (2026-09-25)

Built
- Pure, explainable ranking (`services/dashboard/scoring.ts`): priority, due proximity,
  blocked, blocking, staleness, overdue dependencies, pins and a local adjustment, each
  with a reason and its points. Weights are editable in Settings > Ranking.
- Dashboard sections from one snapshot of the cache: Top focus (with a "why here"
  breakdown), Waiting on me (unseen comments from others on your issues and mentions of
  you), I am waiting on, At risk (blocked, stale, past due, due soon and not started),
  Due soon, pending proposals, and Epic health per tracked epic (done, in progress, to
  do, blocked, stale). Blocked and blocking come from Jira issue links.
- Pin, snooze (tomorrow, 3 working days, a week) and ranking adjustments, stored in
  `issue_meta` only and never sent to Jira.
- Daily brief: facts from code, prose from one `daily_brief` call validated to name
  every overdue dependency and the top due-soon and focus items; cached until the facts
  change, and skipped entirely when there is nothing to report.
- Quick intake stays on the dashboard; the dashboard refreshes after syncs, decisions
  and dependency changes, and every five minutes so relative dates roll over.

Checks
- Changing a weight reorders Top focus predictably (unit test).
- With 2,000 issues synced from `mock:jira`, loading and building the dashboard takes
  about 70 ms in tests (FR-5 AC: under 1 second).

Not verified yet
- The brief with a real model, and the dashboard in the running app.

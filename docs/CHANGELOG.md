# Changelog

## v0.0.1 (2026-09-26)

First release: everything below, Phases 0 to 8 and the features and fixes after
them. Bundles are unsigned; macOS and Windows warn on first open.

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

## Atlassian Cloud support and network (2026-09-25)

Why: the user's Jira and Confluence are Cloud only (design.md D19), and the company
network uses a PAC-configured proxy with TLS inspection (D20).

Built
- Deployment detection (`*.atlassian.net` is Cloud) with an override, account email and
  API token for Cloud, a shared credential resolver, and Confluence reusing the Jira
  token on the same site.
- Jira Cloud: `search/jql` with page tokens, account IDs for users, assignment by
  accountId, epics through `parent`, create metadata in both shapes, `/priority/search`,
  `[~accountid:…]` mentions, 429 retries honouring `Retry-After`.
- Confluence Cloud: `/wiki` base, v2 page fetch with the space key, v1 CQL search.
- Network: OS trust store in addition to bundled roots, manual proxy with bypass list
  and optional login (password in the keychain), request failures written to the log.
- `mock:confluence --cloud`; tests for Jira Cloud sync and writes against a stubbed
  Cloud, and for Confluence Cloud import end to end.

Verified by the user
- Test connection and sync against the real Jira Cloud site through the manual proxy.

Not verified yet
- Confluence Cloud on the real site; Cloud issue creation and epic changes on the real
  site; whether `search/jql` returns wiki strings rather than ADF for descriptions.

## Portable model output schemas (2026-09-25)

Why: all three Gemini models scored 25% on the intake eval because their structured
output collapsed the proposal union to its first branch (design.md D21).

Built
- `services/llm/portable.ts`: every object call sends a schema without `anyOf`,
  `oneOf`, `const` or `null`, maps "" back to null and validates with zod.
- `classify_item` proposals are one flat object; per-kind required fields are checked
  in `validateItemOutput`. Prompt version 2.
- Intake validation checks a project's issue types and statuses only when Jira's
  project metadata was fetched at sync, not from the cache alone.
- Fewer questions (prompt version 3): the model decides details it can reasonably
  pick, such as a priority, and states its assumption; it asks only when the issue,
  person or kind of action is unclear. An undecidable date leaves the date empty
  instead of blocking the proposal. Candidates show their priority and due date.
  Low confidence alone no longer adds a generic question when there are proposals.

## Inbox threads (2026-09-26)

Why: the user wanted to ask for changes to proposals in conversation rather than edit
fields or reject them (design.md D22).

Built
- Each inbox item is a thread of messages (`inbox_messages`); proposals and questions
  appear under the turn that made them. Existing items migrate to one-turn threads.
- Composer: pastes become quoted, untrusted blocks; typing is a trusted instruction;
  a pasted block can be turned into the user's own words.
- `Intake.reply`: new pasted text adds items; a typed reply answers the open question
  or revises the items it is about (`route_reply`, fast tier, only with several
  items). Revisions run the same schema-bound classify step with the thread's
  instructions, decided proposals and current proposals; replaced proposals become
  `superseded` and are recorded as correction examples.
- A failed turn keeps the user's message and shows "Try again".
- Eval cases for a typed instruction with a paste and for follow-ups that add or drop
  a proposal.

## Sprint calendar (2026-09-26)

Why: "end of the second sprint of Q3" could not be turned into a date, and sprint
names differ between teams (design.md D23).

Built
- Sync keeps every sprint's board, state and dates: from issues' Sprint field (legacy
  strings and objects) and from the Agile API's board sprints, with the full history on
  full syncs so positions within a quarter are correct.
- `services/sprints/calendar.ts`: quarter labels (with a fiscal-year start month in
  Settings > General), positions of sprints within a quarter, and projected sprints
  from each board's usual length and cadence, marked as estimates.
- The classify prompt lists the sprints of the boards behind the item's projects; the
  model only matches the wording to a listed sprint and uses its end date.
- Eval cases for "the second sprint of Q4" and "this sprint", with dates checked.

## Phase 6: communication drafting (2026-09-26)

Why: FR-6. Drafts are local records edited directly, not proposals (design.md D24).

Built
- `communications` keeps the request notes, the generated short and standard variants,
  the chosen text, the regeneration instructions and the language (migration 0008;
  earlier requests move their notes to `notes_md`).
- `prompts/draft.ts`: code assembles the recipient's profile, team, language, tickets
  (as untrusted input), the dependency with first request date and earlier chases,
  recent messages to the recipient and memories about them. `validateDraft` requires
  an incident chase to name the incident and a chase to say when it was first
  requested, rejects placeholders, and needs a subject for email.
- `Comms.generate` (standard tier) with repair on failed checks; `comms/queries.ts`
  for create, edit, copy, mark sent (logs a follow-up on the dependency and schedules
  the next one) and delete.
- Drafts page: list, composer (recipient, purpose, channel, dependency, tickets,
  notes), editor with short and standard tabs, subject for email, rewrite with an
  instruction, copy to clipboard, mark sent, recent messages to the same recipient.
- "Draft a chase" on the Waiting page rows and dependency sheet opens the draft and
  writes it; approved `draft_message` proposals link to their draft.
- Live drafting eval: an incident chase to a formal and to a casual contact.

Checklist
- Two contacts with opposite profiles yield clearly different tone: yes with GLM 5.3
  Flash (the formal draft is fuller and more careful, the casual one a short nudge).
- Marking sent updates the dependency's last follow-up and next chase date: covered by
  `comms.test.ts`; not yet checked by the user in the UI.

## Phase 7: learning, memory and chat (2026-09-26)

Why: FR-7, FR-8 and FR-9.4 (design.md D25, D26).

Built
- Memory page: rules, facts and preferences with subject, importance (weight),
  provenance (added by you or inferred, from which thread), confirmation and usage;
  corrections with the input, what was proposed and what you changed.
- Memory ranking in retrieval: overlap with the input, a boost for memories about the
  item's issues, sender, contacts and teams, then weight, recency and use count.
  Memories that reach a prompt record `last_used_at` and `use_count`.
- Corrections now name the fields that changed ("assignee: (none) -> ana.b"); before,
  a changed assignee or priority was invisible to the model.
- "Suggest rules" (strong tier): patterns seen in at least two corrections become
  `remember` proposals in a new thread; nothing is remembered until approved.
- Evaluation replay (Settings > Models): re-runs decided inbox items from their
  snapshots on a chosen tier or model; agreement per proposal kind and repeated
  rejections. `Llm.object` accepts an explicit target for this.
- Chat page: `useChat` over an in-process transport; a streamed tool loop (tier
  picker, 8 steps) with read-only tools (tickets, ticket details, what you wait on,
  contacts, notes, focus list, Confluence search). Changes go through
  `propose_actions`, which runs intake and links to the new thread.
- `@ai-sdk/react` added; `ai` and the provider packages updated so one copy of each
  is installed.

Checklist (GLM 5.3 Flash)
- Two corrections of the same kind make the third similar input classify correctly:
  yes ("two corrections teach the third" eval case).
- Chat answers "what am I waiting on from team X" from local data and turns "comment
  on ABC-12 that we are blocked" into a pending proposal: yes (live chat eval).

## Phase 8: hardening and packaging (2026-09-26)

Why: the implementation plan's last phase (design.md D27).

Built
- Request guard in the `Fetcher`: only configured Jira, Confluence and model hosts
  (plus a URL being tested in settings); anything else is refused before it leaves the
  app. Offline, requests fail at once with a clear message.
- CSP adds `object-src 'none'`, `base-uri 'self'`, `frame-ancestors 'none'`,
  `form-action 'none'`.
- Settings -> Data: export everything to one JSON file (no keys, no Jira cache),
  import with zod and per-row checks after saving a backup of the current data, and
  clear the Jira cache.
- Every service error has its own toast title; network failures link to the network
  settings. A test fails when a new service error has none.
- Offline: an "Offline" badge replaces the sync status, the sync timer skips runs and
  syncs when the network returns; cached pages keep working.
- Tests that the log and exports never contain keychain values, bearer tokens or API
  keys.
- README (setup, Jira and Confluence permissions, troubleshooting) and a CI workflow:
  typecheck, lint and tests, then `tauri build` on Linux, Windows and macOS with the
  bundles as artifacts.

Checklist
- `bun run tauri build` on this Arch machine: the release binary, `.deb` and `.rpm`
  build; the AppImage step fails in linuxdeploy here (a local tooling issue; CI builds
  on Ubuntu 22.04).
- No secret string in the log file or the export: covered by `log.test.ts` and
  `transfer.test.ts`.
- Fresh install reaching a working dashboard: to be checked by the user on the built
  bundle.

## Chat history (2026-09-26)

Why: testing showed chat conversations vanished when switching pages and had no
history (design.md D28, superseding D25's "not stored").

Built
- `chat_conversations` table (migration 0009): title from the first question and the
  UI messages as JSON, saved after every answer, including stopped or failed ones.
  Included in the full export.
- Chats stay in memory while the app runs, so leaving the Chat page and coming back
  shows the same conversation, even mid-answer; the page reopens the last one.
- Chat page: a list of past conversations with delete, and "New chat".

## Cleanup: tests, tooling, docs (2026-09-26)

Why: duplicated test setup had drifted, and the docs still described the pre-D19 plan.

Changed
- Tests: one fake Jira (`fixtureRoutes()` in `src/test/seed.ts`, now with project
  statuses and board sprints) replaces four drifted copies; `src/test/helpers.ts`
  holds `promptOf`, `readThread`, `drainStream`, `testProvider` and `TODAY`, and tests
  that triage, reply or draft pass the fixtures' today. Three unused Jira fixtures
  deleted. The mock-Jira test groups each get their own server.
- `bun run mock:jira` serves `/rest/agile/1.0/board/{id}/sprint` (two boards,
  two-week sprints from 2026-06-29, active around today) and `/project/{KEY}/statuses`;
  issues' Sprint field carries start and end dates.
- `bun run typecheck` also checks `vite.config.ts` and `drizzle.config.ts`.
  `.gitignore` covers `*.tsbuildinfo` and `.tanstack`.
- CI: Bun pinned to 1.4.2 with an install cache; the Linux build runs `cargo test` and
  `cargo clippy -D warnings`; bundles build only on pushes to `main` and manual runs.
- Rust: unused `serde` and `serde_json` removed. The JS http plugin is pinned to
  `~2.6` like the Rust one.
- Webview title is "Secretary"; the missing Vite favicon link is gone (the default
  Tauri icons stay).
- Docs: requirements cover Cloud and point NFR-3 at D27; design.md has "Now:" notes
  where D19–D28 overtook it, plus a corrected data model, endpoint list, task table,
  error types and testing section; the implementation plan is marked as history;
  README lists install caveats for the unsigned bundles.

## Draft handoff to Teams and email (2026-09-26)

Why: copying a draft and pasting it into a new chat or email was the slowest part of
sending it (design.md D31).

Built
- "Open in Teams" on Teams drafts and "Open in email" on email drafts, next to "Copy
  message". They open a Teams chat deep link or a `mailto:` link in the user's own
  app with the message (and an email's subject) filled in, after saving any edits.
  No Microsoft sign-in or Graph; the user still presses Send, then "Mark sent".
- Opening marks the draft copied. Text too long for a link (2000 characters for
  `mailto:`, 4000 for Teams) goes to the clipboard and the window opens without it.
- The button is disabled, with the reason, for a team recipient or a person without
  an email; the latter links to the People page.
- Pure link builders in `src/lib/handoff.ts` with tests for encoding, line breaks,
  several recipients and the length limit. The existing `opener:default` capability
  already allows `https:` and `mailto:` URLs.

## Sprint planner groundwork (2026-09-26)

Why: the sprint planner (design.md D30) needs story points and a way to move issues
into a sprint as approved proposals.

Built
- Story points: sync discovers the field (Cloud's "Story point estimate" type first,
  then a field named "Story Points" or "Story point estimate"), with an override in
  Settings > Jira > Custom fields, and stores `jira_issues.story_points`
  (migration 0010). Numeric strings count; anything else is null.
- `move_to_sprint` proposal: the executor posts the issue to
  `/rest/agile/1.0/sprint/{id}/issue` (`JiraWrite.api: "agile"`), re-fetches it and
  writes the audit log; an issue already in that sprint needs no write. Intake never
  proposes it, it has no edit form, and its rejections are not kept as intake
  correction examples.
- `bun run mock:jira` serves story points (1 to 13, some unestimated) and accepts
  moves into a sprint.

Fixed
- A stray merge marker line in this changelog.

## Sprint focus, clickable tickets, sprint planner (2026-09-26)

Why: the chat suggested an unplanned backlog epic as today's focus (D29); the user
wants help planning each next sprint (D30); ticket keys in the brief should open.

Built
- Top focus is the user's work in the active sprint plus pinned tickets, never
  epics (by type, or by having children); with no active sprint it ranks the whole
  scope. The dashboard names the sprint and its end; the chat's `my_focus` says what
  it covers and the chat keeps focus answers inside it.
- Ticket keys in the daily brief and chat answers are links that open the ticket
  (only keys of synced tickets; code and existing links are left alone).
- Sprint planner (Planning page): the ending sprint's summary, velocity from the
  user's points resolved in the last three closed sprints, candidates (carry-over,
  already planned, ranked backlog, pickups under tracked epics), a drafted plan
  (`plan_sprint`) checked for decided carry-overs, capacity and named blockers, an
  editable review, and one `move_to_sprint` proposal per ticket in an Inbox thread.
  The dashboard suggests planning in the last two working days of a sprint.
- Threads started by the planner or by rule suggestions take no replies (intake
  refuses to revise them; the Inbox shows approve-only).
- Live planning eval (GLM 5.3 Flash: a plan within capacity that defers the blocked
  carry-over and names the risk).

## Ticket panel in place, one keychain prompt (2026-09-26)

- Clicking a ticket anywhere (dashboard, brief, chat, inbox, planner, sheets, Ctrl+K)
  opens the ticket panel on the current page instead of jumping to Tickets; closing
  it returns to where you were.
- All secrets live in one keychain entry, read once per run (design.md D32), so macOS
  asks once instead of once per secret. Existing entries move in on first use.
  Unsigned builds still ask again after each rebuild or update.
- The chat can look at a ticket's pictures (`view_images`, design.md D33): up to four
  image attachments, embedded ones first, shrunk in the webview when large, handed to
  the next model step as an image message. Nothing is saved to disk; the model must
  accept images.

## Storage limit and cleanup (2026-09-26)

- Settings > Data > Storage (design.md D34): the database size against a limit you set
  (default 1024 MB), an "auto cleanup" switch (on by default; a minute after launch,
  then daily) and a "Clean up" button. Shortly after launch and after each sync the
  app warns at 90% of the limit and when over, with a link to the page.
- A cleanup removes model usage records after 90 days, tickets that left the sync
  scope 30 days ago (with their comments), inbox context snapshots after 180 days
  (emptied; threads, proposals and decisions stay; evaluation replay skips them) and
  all but the newest three import backups, then compacts the database. Your own
  records are never removed.
- Logs rotate at 2 MB and keep three files.

## Ranked ticket picker in drafts (2026-09-26)

- The draft composer's ticket picker is grouped and ranked instead of cache order:
  the recipient's open tickets (or the team members'), recently viewed, your focus
  (same ranking as the dashboard, sprint-aware), blocked, other open tickets by
  priority, then done. Each row shows its blocker, priority or status. Tickets that
  left the sync scope are no longer offered.

## Story points in chat, both Cloud point fields (2026-09-26)

- Chat can answer "how many points do I have this sprint" with `sprint_points`
  (design.md D35): total, done and remaining points, computed in code, plus the tickets
  without an estimate. It works for the active sprint or a named one, for you or
  everyone in it. Ticket search and details show each ticket's points.
- Story points come from both Cloud fields ("Story point estimate" and "Story
  Points"), whichever a ticket has filled. Settings > Jira shows every field found.
- When the fields in use change, the next sync is a full one, so existing tickets
  pick up their points without being edited in Jira.

## No native title bar (2026-09-26)

- The app header is the title bar (design.md D36): drag it to move the window,
  double-click to maximise. macOS keeps its traffic lights over the header; Windows
  and Linux get minimise, maximise and close buttons at its right end.

## Report page for stand-ups and catch-ups (2026-09-26)

- New Report page (design.md D37): pick a period (since the last working day, 3, 7
  or 14 days, or any number up to 30) and optionally the tracked epics, and it writes
  what you finished, what is in progress, what is new or changed, what is blocked and
  what is next. Status moves and reassignments come from Jira's change history.
  Copy it as Markdown or as plain text for Teams and email.

## Ctrl+W deletes the previous word (2026-09-26)

- Ctrl+W no longer closes the window; in any text field it deletes the word before
  the cursor, like a terminal (design.md D38). On macOS Cmd+W does the same and the
  Close Window menu item has no shortcut.

## Report styles with the detail to answer questions (2026-09-26)

- The report comes in four styles, picked on the page and remembered (design.md
  D39): talk track + details (default), yesterday/today/blockers, catch-up by epic,
  and a day-by-day timeline. Switching style is instant.
- Each ticket now carries its timeline (status moves with times, reassignments,
  comments, your follow-ups), what it waits on (owner, how long, expected date,
  last chase), who waits on you, and a model-written line on what happened and the
  next step. Sprint health, epic progress and risks are computed in code.

## Collapsible chat list, new app icon (2026-09-26)

- The chat's conversation list can be collapsed to a thin strip (remembered on this
  machine).
- New app icon: the macOS version with its inset rounded tile, the Windows and Linux
  version full-bleed.

## Icon 8b in the app and the sidebar (2026-09-26)

- The app icon moves to the 8b design, and the sidebar shows it instead of the old
  sparkles logo.

## Report limited to the current sprint (2026-09-26)

- The report covers only tickets in the active sprint, like Top focus (design.md
  D40); a "Current sprint only" switch widens it to all your tickets. The report
  header says which sprint it covers.

## Data sources: Obsidian vaults (2026-09-26)

- Settings > Data sources connects Obsidian vaults by name (design.md D41). The chat
  searches and reads them through Obsidian's command line interface (Obsidian
  1.12.7+, turned on in Obsidian's Settings > General > Advanced); Secretary keeps no
  index. A "Test" button checks each vault; the CLI's path can be set if Obsidian is
  installed somewhere unusual.
- Chat gets `search_vault` (Obsidian's search, ranked by Secretary: notes named after
  the query words first, with their matching lines) and `read_vault_note` (a note by
  path or name with its properties, tags and backlinks). Note text is untrusted input
  and reaches the model only when the chat reads it.
- When Obsidian is closed, Secretary starts it on its own and waits until its CLI
  answers, instead of running the command as Obsidian itself.
- Checked against a real Obsidian 1.13.7 (opt-in tests: `SECRETARY_OBSIDIAN_VAULT`);
  fixed reading the tab-separated `file` output and repeated search lines.
- Live eval (GLM 5.3 Flash) answers a decision-and-owner question from a test vault,
  naming the notes.

## Suggested prompts, thread context, cancellations explained (2026-09-28)

- Dashboard: a "suggested prompts" card beside At risk (Plan My Day, Top Priorities,
  Pending Decisions, Weekly Look-Ahead) opens the chat with the question; edit, add,
  remove and reorder them in Settings > General (design.md D42). The chat's empty
  screen shows the same list. New chat tools `pending_decisions` and `week_ahead`
  answer the last two from code.
- Inbox threads: every item now sees the rest of the conversation and the tickets
  named in it, so a later paste can say "that ticket" (D43).
- Closing or cancelling a ticket comes with a comment saying why; a cancellation
  without one is sent back to the model (D43).
- Inbox edit: Epic, Parent and Issue are searchable pickers (epics, possible parents,
  or any synced ticket, the chosen project's first) instead of text boxes; a key that
  is not synced, or a new issue from the same thread ("$new:1"), can still be typed.
- Live eval: two new cases (a cancellation with its reason, a later paste referring
  to an earlier ticket) pass with GLM 5.3 Flash.

## Phase 11: Small-asks home (2026-10-03)

- Settings > Jira > Small asks: a project (from your synced projects), a label
  (default `small-ask`) and "add new small asks to the active sprint" (default on).
  Saving reads the project's create metadata and lists the types a small ask can
  take, required fields the app cannot fill, and types without a Labels field
  (design.md D44). Sync now reads the home project's types even when none of its
  tickets are cached.
- Intake (prompt version 7): with a home set, every new ticket is marked as a small
  ask or planned work. For a small ask, code sets the project (the home, or the
  story's project for a sub-task), the label, you as assignee and the sprint flag;
  the model writes the summary, description and due date and picks the type (Task by
  default) and epic. Who asked is the sender, else a contact the model picks; the
  description ends with "Asked by <name> via <source> on <date>" and the quoted text.
  Without a home nothing changes.
- On Track the Executor creates the ticket with its label, remembers who asked
  (`issue_meta.requester_person_id`, migration 0011) and moves it into the active
  sprint that holds most of your open work, preferring a board that shows the
  ticket's project. A failed move, no such sprint, or a create screen without Labels
  leave the ticket created with a warning on the card. Sub-tasks are not moved.
- Inbox: a small ask and the proposals that hang on it (a dependency, a comment) show
  as one row with type and epic pickers, what it waits on, and Track, which approves
  them in order; a change in the row is saved as an edit you can learn from. The
  cards are under Details. While no home is set, the new-thread page points to the
  setting once.
- Proposals stored before this keep working: new fields have defaults and stored
  payloads are read through the schema, so they load, edit and execute as before.
  The edit dialog gains Labels and Asked by.
- The user's active sprint is now chosen the same way everywhere (planner, sprint
  points, small asks): most open issues, finished ones break ties.
- Tests: the FR-10 acceptance case runs end to end against the mock Jira (one row,
  one click, ticket in the home with label, assignee, sprint, due date and
  requester); the mock Jira stores labels. Four eval cases cover a small ask, a
  sub-task under a candidate story, planned work and the requester; the live eval
  sets the home per case and was not run.
- Not verified in the running app: the Settings section, the Track row and the hint
  were checked by typecheck and lint only, not seen on screen.

Review fixes
- Track runs only what the row shows: a row takes a dependency (and, from Phase 12, a
  blocker link) on the new ticket, one line each on its face; a comment, move, update
  or draft on the new ticket stays a card under the row, as does anything that also
  points at another new ticket not created yet.
- Once Jira has created the ticket, a later failure (the epic link, remembering who
  asked, the action log, finding or joining the sprint) is a warning on an executed
  card, so Retry cannot create a second ticket.
- A create screen without Assignee or Description now warns like one without Labels,
  and Settings lists such types, plus required fields the app fills only when the
  model gives a value (due date, priority, parent, Epic Link): "needed on every ask; a
  small ask without one will fail".
- Sub-task types are recognised by Jira's flag, stored per project at sync, not by
  name; metadata synced before still works by name until the next full sync.
- The quoted words go to Jira inside `{noformat}`, so pasted `!image!`, `[~user]`,
  `{macro}` or link markup shows as text. A made-up "Asked by" line from the model is
  removed wherever it is, and a reply in the thread keeps the date the ask arrived.
- A proposal card shows a stored payload that no longer parses instead of failing.

## Phase 14: Quick capture and tray (2026-10-03)

Why: filing a small ask meant switching to the app and finding the Inbox
(requirements FR-11, design.md D48).

Built
- Capture: the Inbox composer in a dialog over any page, opened from Ctrl+K
  ("Capture", the first action), the global shortcut, the tray menu and
  `secretary --capture`. Enter files a new thread and closes the dialog; triage runs
  in the background and a toast with "Open" follows. A window that capture had to
  show (hidden or minimised) goes back the same way, also when the dialog is left
  without sending.
- One notification when a capture finishes with proposals or questions while the
  window is out of sight; a failed triage while hidden says so too.
- Tray icon with Open Secretary, Capture and Quit. Closing the window hides it while
  "keep running in the tray" is on (default) and the tray exists, so sync, reminders
  and the shortcut keep working; every close path (the app's button, Alt+F4, the red
  button, Close Window) goes through the same check. The macOS Dock icon reopens the
  window. The webview is not throttled in the background on macOS.
- One running instance: a second launch focuses the window, or opens Capture with
  `--capture`; a first launch with `--capture` starts with Capture open.
- Settings -> General -> Capture and tray: the shortcut (blank turns it off),
  close-to-tray, and why the tray or the shortcut is unavailable with what to do.
- Rust: `tauri-plugin-global-shortcut` 2.3 and `tauri-plugin-single-instance` 2.4
  (the newer releases need tauri 2.12), Tauri's `tray-icon` feature, and
  `src-tauri/src/capture.rs`. All three native sources emit one `capture://open`
  event; the webview does the rest.

Decisions and defaults
- Shortcut `CommandOrControl+Shift+Space`; close-to-tray on.
- On a Wayland session the shortcut is not registered (an X11 grab through XWayland
  only fires while an X11 window has focus); Settings shows how to bind
  `secretary --capture` instead.
- On Linux the AppIndicator library is looked up before the tray is built; without
  it there is no tray and closing quits, as before.
- Debug builds on Linux use their own D-Bus name, so `tauri dev` runs beside an
  installed copy.

Checklist
- `cargo check` and clippy pass; typecheck, tests and lint are green.
  `src/app/capture.test.ts` covers the open-capture event and the submit path over
  the real intake (thread filed, window put back before triage ends, one
  notification only when hidden), and a Rust test covers the `--capture` flag.
- Window controls (D36), by code review: minimise and maximise are unchanged; close
  sends a close request, which the native handler turns into hide only when the
  setting is on and the tray exists, and otherwise closes the last window, which
  quits.

Known limits
- Not run: nothing in this phase was tried in the running app (tray, shortcut,
  second launch, notifications, hide and restore on macOS, Linux and Windows).
- GNOME without the AppIndicator extension has the library but shows no icon;
  Settings cannot tell, so turn close-to-tray off there or relaunch to show the
  window.
- On Linux and Windows the hidden webview's timers may be throttled by the engine;
  the 10-minute sync and reminder timers tolerate that.

Fix (macOS, after a first run there)
- Closing to the tray hid only the window, which left the app active with no window
  to take the keyboard; the Dock and Cmd+Tab did not bring it back and nothing could
  be typed (tauri#7540, #2149). On macOS hiding is now at the application level, as
  Cmd+H: closing, and putting the window back after capture, hide the app, so focus
  returns to the previous app and the Dock icon stays; the tray, the shortcut, a Dock
  click and a second launch unhide the app, then show and focus the window. Linux and
  Windows still hide the window. The choice lives in `capture.rs` (`hide_main`,
  `reveal`); the webview no longer hides the window itself but calls
  `capture_restore` and `capture_window_hidden`, and loses `core:window:allow-hide`.
- Troubleshooting switches for the desktop pieces this phase added: `SECRETARY_NO_TRAY=1`
  starts without the tray icon, `SECRETARY_NO_SHORTCUT=1` without the global shortcut
  plugin and `SECRETARY_NO_SINGLE_INSTANCE=1` without the single-instance plugin;
  Settings shows the first two. Added while chasing a macOS 26 report
  (`tauri dev` window shown but never activated, no Dock icon, typing went to the
  previous app). The cause was the launch, not the app: started from the built-in
  Terminal app, the same build works, and every build back to Phase 11 behaved the
  same from the other terminal. README Development says so.
  A Rust test pins the `restore` payload. Not yet re-run on macOS.

## Phase 15: Navigation (2026-10-03)

Built
- Seven pages in the sidebar (design.md D50, FR-13): Today, Inbox, Tickets, Waiting
  on, Sprint, Chat, Context. Today is the dashboard under its new name; Phase 16
  rebuilds it.
- `/sprint` has tabs Plan (was `/planning`), Report (was `/report`) and Epics, which
  takes the epic health rollup off the dashboard and loads it on its own.
  `/context` has tabs People, Teams and Memory. The tab is a zod-validated search
  parameter (`?tab=`); a missing or unknown tab opens the first.
- `/planning`, `/report`, `/people`, `/teams` and `/memory` redirect to their tab and
  keep their search parameters: a contact or team `id`, an open ticket, and the
  Memory page's own `tab`, which is now `list` (`memories` or `corrections`). Every
  link in the app, the chat agenda's and the Inbox's "plan it" and "edit rules"
  hints, and the command palette point at the new tabs.
- The draft composer opens as a panel (a Sheet over the current page) from a ticket,
  a contact, a team, Waiting on and dependency cards ("Draft a chase"), the Inbox's
  "write it now" and Ctrl+K "New draft". A new draft can start with a recipient,
  tickets, a dependency, a purpose, a channel and notes; writing it shows it in the
  same panel. "All drafts" opens the Drafts page.
- The Drafts page stays and comes back to the sidebar with Settings > General "Show
  Drafts in the sidebar" (`general.draftsInSidebar`, default off). The command
  palette always lists it, and each Sprint and Context tab.
- Settings > Advanced holds task routing and evaluation replay (from Models, which
  keeps the tiers) and the ranking weights (the Ranking tab is gone);
  `?tab=ranking` opens Advanced. Nothing was removed.
- Route tests run the app's route tree in a memory history: every old path lands on
  its tab with its parameters, the tab parameter falls back, and the old settings
  tab opens Advanced.

Decisions and defaults
- The panel closes when its own links go to another page (a dependency, a contact);
  a ticket link opens the ticket panel on top of it.
- Teams get "Draft a message" too; a ticket's draft starts with that ticket, a
  contact's or a team's with them as the recipient.
- Switching Sprint or Context tabs unmounts the other tabs, as leaving the old pages
  did: a drafted sprint plan that was not sent is lost when you switch away.

Not verified yet
- Nothing here was run in the desktop app: the sidebar, the tabs, the panel over the
  ticket and dependency sheets, and the redirects in a real window were checked by
  typecheck, the route tests and review only.

## Phase 12: Jira links and blocker wake-up (2026-10-03)

Why: "do this when PLAT-812 is done" had nowhere to go, and nothing noticed when a
blocker outside the sync scope closed (requirements FR-3.8, design.md D45).

Built
- Intake (prompt version 8) proposes "blocked by" links (`link_issues`, target and
  blocker) when the input says something waits for a ticket ("when X is done", "after
  X ships", "once X is deployed", "blocked by X"). It is offered only when sync has
  found the instance's "blocks" link type (`GET /issueLinkType`, kept in
  `jira.linkTypes`). Candidates show what they are already blocked by; a link to
  itself, one Jira already has, a duplicate or two issues blocking each other go back
  for repair.
- A ticket named in the text that the cache does not hold (another team's PLAT-812)
  is read once from Jira and offered as a candidate.
- On approval the Executor posts the link, reads the target back and checks it reads
  "target is blocked by blocker"; a link stored the other way round is deleted and
  posted swapped. Approving a link Jira already has writes nothing.
- A small ask that waits for a ticket shows "Blocked by PLAT-812" on its Track row,
  and Track creates the ticket, then the link. The proposal card and edit dialog
  show both ends.
- After every sync the blockers of your open tickets that the run did not return are
  read with one `key in (...)` search per 100 keys (status and resolution date only)
  into `jira.blockers`; ranking, the report, planning and the picker prefer that
  state to the copy embedded in the link. `issue_meta` keeps each ticket's open
  blockers; when the last one closes the ticket wakes up (`unblocked_at`,
  `unblocked_by`, migration 0012), and a blocker that reopens puts it back to sleep.
- The reminder loop sends one notification per woken ticket ("PAY-5 is unblocked",
  with the reason), under the same Reminders setting as follow-ups.
- For Today (Phase 16): `loadWokenTickets` in `src/services/blockers/queries.ts`
  lists woken tickets, newest first, with the reason ("PLAT-812 moved to Done on
  2 Oct"); the rules are the pure `wokenTickets` in `blockers/logic.ts`.
- Mock Jira: `GET /issueLinkType`, `POST /issueLink`, `DELETE /issueLink/{id}`, links
  on both issues, JQL `key in (...)`, `--reversed-links`, and a `--cloud` shape (Basic
  auth, `/search/jql` token paging, account ids, parent epics, `/priority/search`).

Decisions and defaults
- The POST names the blocker as `inwardIssue`; the direction check is what makes
  that safe on instances that read it the other way.
- "Your open tickets" for the blocker step are those assigned to you and not done.
- A key is read from Jira once per app session, at most five per pasted item.
- A removed link wakes a ticket like a closed blocker; the reason says the key "no
  longer blocks it".
- At most five wake-up notifications per check; the rest follow ten minutes later.

Checklist
- FR-3.8 AC in a service test against the mock Jira (`blockers.mock-jira.test.ts`):
  the link is created on approval, the blocker closes outside what incremental sync
  returns, the next sync reads it with `key in (...)`, sets `unblocked_at` and one
  reminder is due, none after it is sent; a reopened blocker clears it. The same flow
  runs in the Cloud shape.
- The direction check runs against a mock that stores links reversed: POST, DELETE,
  POST swapped, one correct link left.
- Two eval cases (a small ask blocked by PLAT-1, which is outside the fixtures and
  read once; an existing ticket blocked by another) and scripted-model tests for the
  schema, rule, validation, mapping and the Track row. The live eval was not run.

Known limits
- Not seen in the running app: the Track row line, the card, the edit dialog and the
  notification were checked by typecheck, lint and tests only.
- Only "blocked by" links are written; other link types are not.
- No Today UI yet; woken tickets are only notified until Phase 16 lists them.

Review fixes
- Links never make a cycle: validation sends back a link whose blocker is already
  blocked by the target, and the Executor refuses it before posting. The swap after a
  reversed POST deletes only a link id that was not there before that POST, so a link
  the user had is never removed; if the swapped POST fails, the error says the issues
  are unlinked now and Retry links them again.
- Only a definite answer changes blocker state: a blocker not read this run keeps its
  last entry in `jira.blockers`, and a ticket with a blocker of unknown state (no
  entry, or 403) does not wake. A search that fails with 400 is split in two until
  the bad keys are found; 404 means the link is gone (stored with `gone`, read as not
  blocking, "no longer blocks it"); 404 and 403 are remembered for seven days in
  `jira.blockersUnread` and forgotten when the link goes. A key the search did not
  return (moved, renamed) is read on its own and stored under the key the link
  names; Cloud's next-page token is followed. Other failures stop reading for that
  run.
- A ticket that is no longer one of your open tickets forgets its blockers, so it
  returns as first seen; woken tickets must still be assigned to you.
- The re-fetch after every Executor write updates that issue's entry in
  `jira.blockers` and runs the wake-up for the tickets it blocks, so closing a
  blocker from the app shows at once.
- A ticket named in pasted text is stored out of scope (`stale`): offered by its key,
  but not in project lists, the tickets tree, ranking or the blocker step, and
  removed by cleanup. A re-fetch keeps a cached issue's scope flag. `/browse/KEY`
  links count only on the configured Jira site, and a key is marked read only after
  Jira answered (found, 404, 403).
- The requester's name in a small ask's "Asked by" line is escaped for Jira. Edited
  descriptions where the block is no longer last were already covered by D51.
- While reminders are off, wake-ups are marked notified without a notification, so
  turning reminders on sends no burst.

## Polish: Sprint plan, tray notice, palette (2026-10-03)

- Sprint: the Plan tab stays mounted, hidden, once opened, so a drafted plan that
  was not sent (and its notes, picks and goal, or a draft still being written)
  survives switching to Report or Epics and back. Report and Epics still load only
  when opened. Leaving the Sprint page still discards it. Context was checked: its
  edits are in modal dialogs and sheets, so only the People search text resets.
- Tray: the first close that hides the window to the tray sends one notification,
  "Secretary is still running in the tray. Quit from the tray menu, or turn this off
  in Settings." Once ever (`capture.trayNoticeShown`); a refused notification
  permission does not use it up. The native close handler emits
  `capture://hidden-to-tray` only when it hid the window, so nothing is sent without
  a tray. Saving Settings > Capture now keeps the flag.
- Command palette: "New draft" moved into the Actions group, after Capture.
- Not run in the desktop app: the notification and the hidden Plan tab were checked
  by cargo check, typecheck, unit tests and review only.

## Phase 13: Waits from intake, away dates (2026-10-03)

Why: pasting the answer to something you were waiting on did nothing to the wait,
and "ask again when they are back from leave" needed a date set by hand on every
wait (requirements FR-3.6, FR-3.7, design.md D46, D47).

Built
- Intake (prompt version 9) sees up to 12 open waits that the pasted text may be
  about: the sender's, a named contact's, the sender's team's, those on a
  candidate ticket, and those sharing words or an incident number with it. It
  can propose `update_dependency` on one of them: resolve ("Bob sent the
  numbers"), log their reply (with a new expected date when they give one), or
  reschedule. A new dependency that a listed wait already covers goes back for
  repair.
- Approving it writes the timeline entry, the new date or the resolution through
  the Waiting page's functions, then updates the remote link of a mirrored wait;
  a failed link update is a warning on the executed card.
- Dependency proposals (a change to a wait, a wait on an existing ticket) show as
  one line with Approve; the full card, with Edit and Reject, is behind the
  expand arrow. A wait on a new small ask still joins its Track row.
- Contacts have an "away until" date (migration 0013): a field on the contact, a
  badge on the People list and the contact, and `update_person.awayUntil` from a
  pasted out-of-office reply.
- While the owner is away a wait sleeps: not overdue, no follow-up due, no
  reminder, no ranking points, last in its group on the Waiting page with "Bob is
  away until 14 Oct". From the first working day after, it is due with "Bob is
  back" until a follow-up is logged; the reminder says so too. The dashboard's
  waiting list, the report facts, planning and the chat tools use the same timing.
- Drafts to someone away say so in the composer and the draft, and the draft
  prompt is told not to ask for anything before they are back.

Proposal text bound for Jira (D51)
- A create's description and a comment's body from a proposal are made safe after
  conversion to wiki markup: a remote image (`![](https://...)`, `!https://...!`,
  with or without `|width=...`) becomes a plain link, and a mention
  (`[~user]`, `[~accountid:...]`, `[name|~user]`) stays only for a contact with a
  Jira id, the ticket's assignee or reporter, or you; any other is written as
  text. The card says what was changed. Image names without a scheme (attachments
  of the same ticket), `{code}` and `{noformat}` blocks, links and formatting are
  left alone. What you type in the ticket view is sent as typed.

Decisions and defaults
- "Back" is the first working day after the away date; "is back" applies only to
  waits opened before that day, so an old date needs no clearing.
- An away date the model proposes must be a real date from today to 180 days
  ahead.
- The next chase after a reply is the date given, else the working day after a new
  expected date, else the usual interval (Settings > dependencies).
- A reschedule needs a new expected date or follow-up date; dates before today go
  back for repair.

Checklist
- FR-3 AC in a service test (`intake/waits.test.ts`): "Bob sent the numbers" from
  Bob offers Bob's wait, and one approval resolves it with a timeline entry and
  the mirrored link marked resolved. An out-of-office reply sets the away date;
  no reminder while away, one with "Bob Ray is back" on the first working day
  after.
- A wait whose owner is away until tomorrow is not due today and is due, with the
  reason, on the first working day after (`dependencies/logic.test.ts`), also
  across a weekend.
- Scripted-model tests for the schema, rule, validation and mapping
  (`prompts/classify-waits.test.ts`); Executor tests for each action, an already
  resolved wait, a missing one and a failed mirror update; three eval cases (a
  wait resolved, a partial reply logged, an out-of-office). The live eval was not
  run.

Review fixes
- The D51 sanitiser is now a scanner instead of a set of regexes. A run of
  backslashes escapes only when odd (`\\` is a line break), so `\\!url!` and
  `\\[~user]` are caught. `{code}` / `{noformat}` blocks count only when lowercase,
  unescaped and closed; every other marker, in any case, is broken up (`{ code}`),
  including in the model's part of a small ask, so it cannot pair with the quote's
  block and turn the quote live. Every link part starting with `~` is a mention
  (`[Bob|~user|tip]`, `[ ~user]`). Every unescaped `!` whose text up to the next
  `!` names a URL, in any wrapping (`![https://...]!`), is defused: a plain web
  embed becomes a link, anything else (`data:`, wrapped URLs) loses its `!`. Its
  output is idempotent, and a table of adversarial inputs in many wrappings is
  checked by an independent checker in the test.
- An away date that is not a real date (`2026-13-01` from an import) no longer
  breaks every waits view; it is ignored, and the contact form rejects it.
- "Is back" can be put off: it also ends when the wait's next follow-up is later
  than the back day, and 14 days after the back day (D47 updated).
- A new wait on a ticket and owner that already have one is allowed when it is
  about something else; incident numbers match whole (INC0012 is not INC00123).
- A retried change to a wait does not log its timeline entry twice.

Known limits
- Not seen in the running app: the compact rows, the contact's away field and
  badges, the Waiting page badges and the draft warning were checked by
  typecheck, lint and tests only.
- Today (Phase 16) is not built; the current dashboard lists a returned owner's
  wait with "is back" and leaves sleeping ones out.

## Phase 16: Today and the sweep (2026-10-03)

Why: small asks beside planned work were trackable after Phases 11 to 15 but
still had no single place to look, and the dashboard spread what needed the user
over seven sections (requirements FR-12, design.md D49).

Built
- Today at `/`: the capture box, then three lists. *Your move*: woken tickets
  (D45), your open small asks with nothing to wait for (by due date, then oldest),
  new comments and mentions, and one row per Inbox thread with decisions. *Their
  move*: open waits (overdue, follow-up due, owner back, the rest), your tickets
  blocked by an open ticket, then sleeping ones (owner away, or the ticket
  snoozed), soonest to wake first. *Sprint work*: Top focus (D29) without small
  asks, with due-soon and at-risk tickets joined in as badges. Every row says why
  in a few words; a list longer than 12 folds behind "Show all"; each list says
  so in one line when empty; without a small-asks home, Your move still lists
  the rest and one line links to the setting.
- `buildToday` (`services/dashboard/today.ts`) is pure over one snapshot and
  replaces `buildDashboard`. A ticket is in one list only; the precedence is
  written down and tested (woken, snoozed, new comment, blocked, small ask,
  sprint work). The ranking itself is unchanged and is now `rankWork`, which the
  brief, the report, the ticket picker and the chat read.
- Row actions without leaving the page, each with a toast (and any warning),
  disabled while running, lists refreshed after: Done (reads the transitions; one
  runs, several give a menu, none is an error; Jira's message when fields are
  needed), snooze (tomorrow, Monday, after the sprint, a date; on a wait it moves
  the next chase), reply draft (to the requester when known), chase draft, log a
  reply, resolve. Jira writes go through the Executor.
- The sweep (Sweep in the header): woken tickets, follow-ups due or overdue,
  owners back, asks due or overdue, and once a week asks untouched for 14 days
  (`sync_state` `sweep.staleAt`). Keys D done, N nudge, S snooze, X drop (asks
  why, then closes as D43 requires: a cancel-like status when the workflow has
  one, else a done one, and a comment with the reason), Space skip, Esc leave;
  "3 of 9" with a progress bar, and a summary at the end.
- The brief opens from a button into a side panel; the plan banner stays;
  suggested prompts are on the Chat page only.
- Chat: `pending_decisions` lists your open small asks with who asked, age, due
  date and where each stands; `waiting_on` also lists your blocked tickets.
- Removed: the old dashboard sections and their tests, the dashboard's prompts
  card, `iAmWaitingOn` and the dashboard's own epic health (Sprint > Epics keeps
  `buildEpicHealth`). Wording that pointed at the dashboard now points at Today or
  the Chat page.

Decisions and defaults
- A new comment or mention ranks above a blocker and a small ask: someone waits
  for an answer. Comments on a snoozed ticket wait until the snooze ends.
- Only tickets assigned to you count as blocked in Their move; a blocked ticket of
  someone else's that you track stays Sprint work with an "at risk" badge.
- Waits are rows of their own, so a sprint ticket with a wait is in Sprint work
  and its wait in Their move.
- A wait on a snoozed ticket sleeps with it.
- "Tomorrow" is the next working day; "after the sprint" is the first working
  day after your active sprint ends.
- On a wait, Done resolves it and Drop logs "Stopped waiting: <reason>" and
  resolves it. A ticket's drop comment is "Dropped: <reason>", or "Closed without
  being done: <reason>" when only a done status is offered.
- The sweep leaves out an overdue wait whose next chase is already set for a
  later day, until that day. The weekly pass counts as run when a sweep that
  held it reaches its summary.
- `buildDashboard` stays as an alias of `rankWork` only because two tests on
  another branch call it.

Checklist
- FR-12 AC: `today.test.ts` builds the three lists from one fixture that mixes
  small asks, waits (overdue, follow-up due, back, sleeping), blockers and sprint
  work, with the order of each list, the precedence, the empty and no-home cases;
  2,000 issues build in under 150 ms. `today.mock-jira.test.ts` loads and builds
  Today over 2,000 synced issues in under a second.
- Done on a small ask transitions it in the mock Jira and the row leaves Your
  move; Drop closes one with the reason as a comment (`today.mock-jira.test.ts`).
- The sweep's order, the weekly pass and the summary (`sweep.test.ts`); the done
  and drop transitions and the snooze days (`closing.test.ts`); the chat's new
  fields (`chat.test.ts`, `agenda.test.ts`).

Known limits
- Not seen in the running app: the page, the three columns, the row menus, the
  sweep dialog and its keys, the brief panel and the draft panel over the sweep
  were checked by typecheck, lint, the build and review only.
- The mock Jira has one done status and no cancel-like one, so the Done menu and
  a drop into a cancelled status are covered by unit tests, not end to end.
- The cancel-like words are repeated in `dashboard/closing.ts`; the classify
  check in `prompts/classify.ts` should import them from there.

Review fixes
- The sweep runs one action at a time through one guard (`dashboard/sweep.ts`,
  pure and tested): a second Enter, a held key or a double-click no longer
  writes twice or acts on the next item. Outcomes are kept by item id and only
  the item an action ran on advances; for 400 ms after the item changes actions
  are ignored. Keys act only with focus on the item, never on auto-repeat, so
  Space on a focused button presses it. Errors offer a Retry for that item.
- Drop takes a cancel-like transition only when it leads to a done-category
  status, so "Reject" back to In Progress is never used. It comments first and
  moves second; a retry does not post the comment again, and a failed move says
  the ticket is still open and Retry closes it (checked against the mock Jira).
- "Chase later" on a wait whose owner is away or just back offers only days
  after the back day; a later chase ends "is back" on Today and in the sweep.
- An overdue wait chased later keeps its badge but sits with the rest of Their
  move, its reason naming the next chase.
- `waiting_on` lists every blocked ticket of yours (new `Today.blocked`), also
  one Your move holds for a new comment. `pending_decisions` leaves sleeping
  waits out of follow-ups due, as the brief does. Chat ages count local days.
- Opening a ticket refreshes Today, so its woken or comment row goes at once.
- One cancel-like word list (`services/jira/cancel.ts`) for classify and Drop;
  the `buildDashboard` alias is removed.
- Read-through of the page: row menus are no longer modal (their items open
  dialogs, which could leave the page unclickable); a Today that fails to load
  keeps the header and the capture box and says why; long wait reasons truncate
  in their badge; the snoozed and pinned icons have names.
- Still not seen in the running app; checked by typecheck, tests, lint and the
  build.

## Live eval: concurrent, verbose, fail-fast; reasoning effort for compatible providers (2026-10-03)

- The intake eval runs every case in its own layer and in-memory database, six at
  a time (`SECRETARY_EVAL_CONCURRENCY`, 1 for one after another); a thread's turns
  stay in order inside their case. Corrections, waits and the small-asks home are
  per case, so nothing is cleaned up between cases. The other live tests
  (drafts, chat, planning, report, vault, fast versus standard) run concurrently
  beside it; each prints its time and model calls.
- Each case prints PASS or FAIL, seconds and model calls (repairs, escalations and
  failed calls from its `llm_calls`) when it finishes. The final report keeps the
  details and adds wall time, total calls, input and output tokens, the five
  slowest cases and which upstream provider answered.
- The run stops when the first three cases all end in the same provider error
  (timeout, rate limit, server or request error), and at once on 401/403, saying
  what to try (`harness.ts`, unit-tested).
- D52: the provider effort setting now also applies to OpenAI-compatible
  providers as `reasoning_effort` (max sends xhigh); "Provider default" still sends
  nothing. The provider form shows it for both kinds. The eval takes
  `SECRETARY_EVAL_EFFORT`.
- Eval only: `SECRETARY_EVAL_PROVIDER` pins OpenRouter's upstream provider
  (`provider.only`, no fallbacks), and the eval's model fetch waits out up to six
  429s with backoff before the app sees one, inside the app's own timeout.
- First run on GLM 5.3 Flash pinned to `deepinfra/fp4`: DeepInfra's shared pool
  answered 429 ("engine overloaded") to nearly every request, so the first three
  cases timed out and the run stopped after 4 minutes instead of grinding on. When
  it does answer, DeepInfra returned the classify call in 15 s (700 output tokens,
  55 of them reasoning) with valid JSON. No intake result yet.
- Eval only: `SECRETARY_EVAL_PROVIDER` takes an ordered, comma-separated list
  (`deepinfra/fp4,streamlake/fp8,novita/fp8`), sent as `provider.order` and
  `provider.only` with fallbacks allowed, so nothing outside the list serves a
  request; one slug still pins that provider. OpenRouter sends a schema-bound
  request only to listed providers with structured outputs, so it did not move on
  from a busy DeepInfra by itself; after a 429 the eval now asks the rest of the
  list at once and backs off only when the last one is busy. The summary counts
  responses and 429s per provider.
- D47, classify prompt version 10: "until D" keeps the person away through D;
  "back on D" makes D the first day back, so `awayUntil` is the day before. The
  first full run had read "until Friday 2 October" as 1 October. A new eval case
  covers the back-on form. Full run on GLM 5.3 Flash: 27 of 27 passed in 4
  minutes, served by StreamLake 34 and DeepInfra 13 after 34 DeepInfra 429s.
## Parent epics outside the sync scope (2026-10-15)

- An epic that synced tickets sit under, but that the sync JQL and tracked epics
  leave out, was never stored. The ticket's epic picker showed it as a bare key, and
  intake could not offer it. Adding an Epic Name in Jira or running a full resync
  did not help, because a full resync only re-reads the scope.
- Sync now reads those parent epics by key after the sub-task pass (design.md D53).
  A full run refreshes them all; an incremental run reads only new ones. A key the
  user cannot see is isolated and skipped. The watermark is unchanged.
- The epic picker falls back to the summary when the Epic Name is blank.

## Small asks: row changes reach every approve (2026-10-15)

- A type or epic changed on a small-ask row was kept only in the row, and only
  Track sent it. Approving the create from its card under Details, or with Approve
  all, created the ticket with the default type and epic.
- The row now saves the change on the pending create as soon as it is picked
  (`Proposals.saveEdit`, design.md D44). The card under Details shows it as edited,
  and every approve path uses it. Saving records nothing; the approval records the
  change as one correction, also when Track sends the same change again. Picking
  the original values again clears the edit.
- A failed create still sends its row changes with Retry.

## Drafts back in the sidebar; chat leaves drafts to the Drafts page (2026-10-15)

- The Drafts page is in the sidebar again, before Chat (design.md D50). It was out
  of the sidebar behind a setting, so in practice it was reachable only from the
  Inbox. The setting is removed; the draft panel from tickets, people and Waiting on
  stays.
- Chat no longer writes its own email or message draft next to a draft request; it
  makes the request and says it is waiting in the Inbox (PR #24, also on `main`).
- The issue picker scrolls inside the edit dialog and shows full summaries (PR #20),
  and the sync buttons keep their labels while a sync runs (PR #23).


## Phase 17: Revoke an approval (2026-10-15)

Built
- Undo data (D54 (1)): the Executor records `undo` in a proposal's result, read
  from Jira just before it writes: the replaced values of an update (priority and
  assignee as names and user ids), the status a move left, the open sprint a sprint
  move left (null for the backlog), the new comment's id, the id of the link it
  made, a wait's state before and after with the timeline entry it added, and the
  changed columns of a contact or team before and after. Creates, waits, memories
  and drafts use the ids their results already held.
- Reverse writes: `delete_issue`, `delete_comment` and `move_to_backlog` Jira
  actions; `JiraClient.myPermissions` and `getComment`; `Executor.reverse` runs a
  Jira action through `run` (logged with the proposal id) or a local change (delete
  or restore a wait, put back a contact or team, forget a memory, delete a draft).
  A deleted issue leaves the cache with its comments and `issue_meta`.
- `jira/cancel.ts` `revokeTransition`: the first transition into a status named
  like cancelled or canceled, won't do, rejected, declined (in that order), else
  one into a done-category status.
- `proposals/revoke.ts` plans in pure code: `revokeBlock` (what stored data rules
  out), `cascadeOf` (the executed proposals of the thread that act on a created
  ticket, by `$new` ref or key, recursively, newest first), and `planEntry` /
  `planRevoke` per kind over facts that `revoke-facts.ts` reads fresh.
- `Proposals.revokePlan` and `Proposals.revoke`. Status `revoked`; the result keeps
  the original fields and gains `revoked: {at, message, warning?}`. A failed step
  stops the run, leaves the proposal executed with `revokeError: {at, message,
  undone}`, and Revoke can be pressed again: each step checks current state, so the
  comment is not posted twice and a deleted thing is not deleted again.
- Inbox: Revoke on executed cards (compact ones too) and on a tracked small-ask
  row, which revokes the bundle through its create. An AlertDialog lists every step
  per proposal, with notes (already undone, closed instead of deleted) and
  warnings (changed since); confirming sends the step texts it showed. A revoked
  card shows the badge, what the approval did struck through, and what the revoke
  did. Old approvals show a disabled Revoke with the reason.
- Mock Jira: `DELETE /issue/{key}` (refused with sub-tasks; 403 with `canDelete:
  false` or `--no-delete`), `GET /mypermissions`, `GET` and `DELETE
  /issue/{key}/comment/{id}`, `POST /rest/agile/1.0/backlog/issue`, a `subtasks`
  field, and a done-category Cancelled status with `cancelStatus` or
  `--cancel-status`.
- Tests: the FR-14 AC against the mock with and without delete permission, a
  failed transition finished by a second Revoke, each Jira kind against the mock
  (a priority changed in Jira since is kept and named), each local kind against
  the database, the planner per kind and the cascade, and the undo data per kind.

Decisions and defaults
- Recorded in D54's Built note: what "changed since" compares for each kind, a
  cascaded proposal that cannot be undone is left and named instead of blocking
  the revoke, drafts that only mention the ticket stay, the revoke refuses to run
  when the fresh steps differ from the confirmed ones, and a revoked proposal
  counts as rejected in the thread context of later turns.
- The cancel status is opt-in in the mock, so the Today tests that close a ticket
  as Done keep their workflow.
- The new `revoked` value of `proposals.status` needs no migration (a text
  column); `db:generate` produced none.

Review fixes
- The cascade is planned end to end: entries are planned newest first, each
  against the facts as the steps before it leave them (a status moved back,
  values and assignee put back, a sprint, sub-tasks deleted, waits, contact and
  team columns). A ticket moved to Done in a later turn now goes back to To Do
  and then to the cancel status instead of staying in To Do; a sub-task the
  cascade deletes no longer keeps its parent from being deleted; two changes of
  one field or status go back to the first value.
- Steps name targets, not ids: a status move is `transition_to` a status, and
  `Executor.reverse` picks the transition available when it runs. The cancel
  status of a ticket the cascade moves first comes from the project's statuses
  for its issue type (`revokeStatus`). The confirmed-steps guard still compares
  the described steps.
- `proposals/revoke-run.ts`: right before a delete its sub-tasks are read again;
  a ticket that still has some, or whose delete Jira refuses (400 or 403), is
  closed in the same run (the comment unless present, then the cancel
  transition available then) with a warning. An assign Jira refuses is skipped
  with a warning instead of failing the revoke.
- The confirmation and warnings name users by display name: recorded at approval
  in the undo data (`names`), else from the fresh read, the cache or contacts;
  the user id only when nothing else is known.
- A retried update_issue or update_dependency keeps the undo data its first
  attempt recorded before writing (the earliest value per field), kept on the
  failed result.
- Deleting a mirrored wait treats a 404 on its remote link as gone, and the
  remote-link writes of a revoke or wait update are logged with the proposal id.
- `Proposals.revoke` holds every proposal its cascade covers; a second revoke of
  any of them fails with `busy`. The inbox disables Revoke across the thread
  while one runs.
- A revoked create rejects the still-pending proposals of its thread that act on
  the ticket (no correction recorded) and files the thread.
- FR-14.5 on the card: a sent or copied draft and a sprint move whose earlier
  sprint has closed show a disabled Revoke with the reason before the dialog
  opens (`localRevokeBlock`, `ProposalView.revokeBlocked`).
- Mock Jira: transitions follow a workflow (which are available depends on the
  issue's status, and `POST /transitions` refuses others), deleting a missing
  remote link answers 404, and tests can refuse one issue's delete and one
  user's assignment.
- Tests: the planner over each scenario above, and against the mock a ticket
  moved to Done, two moves, two priority changes, a sub-task, a refused delete
  and assign, a retried update, a mirrored wait whose link is gone, two
  concurrent revokes, and pending members rejected.

Thread context (FR-14.6)
- Later turns of a thread no longer fold a revoked proposal into the rejections:
  "Already decided" shows it as approved, then revoked, with what the revoke did
  (the ticket deleted, or closed and moved to its status; other kinds the stored
  revoke message), and a pending proposal dropped because its ticket was revoked
  as dropped with that reason (`intake/decided.ts`). A revoke that changed
  nothing back says so instead of "Undone", with what was left as it is; a
  ticket closed before the revoke reads as closed in its status. `$new` refs
  there name the created key.
- The `revoked` record keeps `ticket` (deleted, or closed with its status and
  whether the revoke moved it), written from what the run did, and `unchanged`
  when nothing was changed back; older records are read from their message
  (`revokedTicket`).
- Classify prompt version 11: when something was revoked, a rule says a revoked
  action is undone, a deleted ticket no longer exists and a closed one stays
  closed unless the user asks to reopen it, and neither is proposed again unless
  the user's newest instruction asks to redo it; the input asking for it does
  not count. The "Already decided" header carries the same exception. Older
  snapshots replay as they ran (the rule follows the stored context).
- A ticket a revoke deleted is no longer read, named as a reference or offered by
  any retrieval source (`exclude` on the snapshot request). A ticket already gone
  from Jira when it is revoked (or whose DELETE answers 404) leaves the cache
  like one the revoke deletes (`forget_issue` reverse op). One the revoke closed
  stays a candidate in its new status. A dropped card shows its reason.
- Tests: the prompt lines, header and rule, the thread outcomes from stored and
  older records, retrieval exclusion, and against the mock a tracked ask revoked
  (deleted, deleted in Jira first, and closed) followed by another turn.

Known limits
- The revoke comment is matched among the newest 100 comments of the ticket.
- Deleting a ticket leaves waits created outside its thread pointing at the
  deleted key (D54 revokes only what the thread did).

## Phase 18: Story points on proposals (2026-10-15)

Built
- Payloads (D55): create_issue gains `storyPoints` (number 0 to 1000, or null) and
  `storyPointsEstimated`; update_issue `changes` gains `storyPoints` (null clears).
  Both default, so stored proposals still parse. `describePayload` shows "N points",
  "(suggested)" while estimated. Settings > Jira > Small asks has a default
  (`smallAsks.defaultPoints`, empty by default).
- Scale: `retrieval/points.ts` counts the cache's point values per project (Epics,
  sub-tasks and stale tickets left out) and keeps the 8 most frequent of the
  candidates' projects and the small-asks home, else of every project, sorted
  ascending. The snapshot stores it as `pointScale`, and candidates carry their
  points.
- Classify prompt version 12 (11 is taken by a parallel fix): `storyPoints` (text,
  parsed in code, since the portable schema cannot leave a number empty) and
  `pointsSource` (`stated`, `estimated`; only `stated` while the scale is empty),
  the rule (use stated points, estimate only new tickets from the scale, never
  re-estimate an existing ticket, no points on an Epic), the scale under Projects
  and each candidate's points. Snapshots without `pointScale` (older versions)
  get none of this, so they replay as they ran.
- `prompts/points.ts` checks in code and the repair prompt says why: a number from
  0 to 1000; a source with the number; `estimated` only on create_issue and only a
  scale value; `stated` only when the input or the user's instructions give the
  number next to a points cue (points, pts, SP, "-pointer", estimate, "like a 5"),
  every number of a list counting, issue keys in any case, dates and times not;
  update_issue points only `stated` and not the value the ticket has; no points
  on an Epic. In a revision the pending proposal it revises (a create by ref, an
  update by target) may keep the user's points, never an estimate. A small ask's
  estimate is not checked when the default replaces it. Payload building gives a
  small ask without stated points the default when one is set, and an Epic none.
- Cleared points stay cleared: emptying a create's points sets
  `storyPointsCleared`; the revision's pending shape carries `pointsCleared`, and
  no estimate or default comes back unless the user's instructions give a number.
  An update's clear (`storyPoints: null`) survives a revision the same way.
- Executor: a create writes the first effective story point field (D35) that the
  create screen lists (`pointsFieldOn`); a screen without one creates without
  points and the result warns. An update reads the issue's story point fields and
  `GET /issue/{key}/editmeta`, writes the on-screen field that holds its points,
  else the first on the screen (`pointsFieldForIssue`), fails (`invalid`) naming
  the reason when the screen has none, and records the previous points and the
  field in its undo data; a retry keeps the field the first attempt chose.
  `update_fields` carries the points with their field (`pointsField`).
- Revoke puts the previous points back in the same field under the changed-since
  rule; points that were empty before are cleared.
- UI: a Story points field in the edit dialog (hidden for an Epic; changing the
  type to Epic drops the points), a "Clear story points on the ticket" checkbox
  for update_issue (FR-15.3), the points on the small-ask row next to type and
  epic (saved on blur or Enter, like the row's other fields), and a Points row on
  cards with a "suggested" badge. A changed or cleared value is the user's, no
  longer a suggestion.
- Mock Jira: Story Points on the create and edit screens of standard types (not
  Epic or Sub-task); `noPointsOnCreate` drops it from a project's create screens;
  with `--cloud` "Story point estimate" too, empty until written. Like Jira, a
  create or edit that sets a field its screen lacks, or points that are not a
  number, gets 400; the edit screens list summary, description, priority, due
  date and labels.
- Tests: the scale and its SQL, the stated-number check, every validation rule,
  per-proposal kept points, cleared points across a revision, payload building
  with and without the small-ask default, the field choice from create and edit
  metadata (both Cloud fields on screen), the create and update mappings,
  describePayload and the edit form; against the mock Jira the FR-15 AC (3
  stated, a suggestion, the small-ask default, "is more like a 5" and its revoke,
  a create screen without the field, an update without it), the Cloud two-field
  path end to end, and the mock's 400s. Three live eval cases.

Known limits
- On update_issue an empty points field means "no change"; clearing uses the
  checkbox.

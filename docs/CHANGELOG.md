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

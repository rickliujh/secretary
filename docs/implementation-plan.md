# Secretary: Implementation Plan (handover to Claude Opus 5.5)

> **Status:** Phases 0–8 are built and are history; later changes are decisions
> D19–D43 in design.md section 12 and entries in CHANGELOG.md. Phases 11–16
> (small asks, approved 2026-10-03) are at the end of this file and are built too
> (2026-10-03); what changed on the way is in D44–D51 and CHANGELOG.md.

Read `requirements.md` and `design.md` first, then `../CLAUDE.md`. Work phase by
phase. Each phase ends with its checklist passing, a short entry appended to
`docs/CHANGELOG.md`, and the phase's feature branch squashed and merged to
`main` locally. Do not start the next phase
with a red checklist. If a library assumption in `design.md` turns out wrong,
record the replacement in the decisions log (design.md section 12) before coding
around it.

Things only the user can provide (ask once, at Phase 0, then proceed):

- Jira base URL, a PAT, one or two project keys and epic keys to test with.
- Confluence base URL and PAT.
- At least one LLM endpoint (kind, base URL, key, model).
- Three to five real pasted messages for intake testing (sanitised is fine).

## Phase 0: Scaffold and settings (foundation)

Tasks
1. `bun create tauri-app` (React, TypeScript, Vite). Tailwind v4, shadcn init,
   TanStack Router and Query, Effect, zod, drizzle-orm + drizzle-kit.
2. Tauri plugins: http, sql (sqlite), store, clipboard-manager, notification, opener,
   log, dialog, fs. Capabilities file with an http scope placeholder updated from
   settings at runtime (or a permissive `https://**` scope during development,
   tightened in Phase 8).
3. Keychain: Rust commands `secret_get/set/delete` using the `keyring` crate (or
   `tauri-plugin-keyring` if maintained). `Secrets` Effect service on top.
4. `Db` service: drizzle schema for all tables in design.md section 4; migrator that
   bundles SQL via `import.meta.glob` and applies pending migrations at startup.
5. `Settings` service over plugin-store with a zod schema and defaults.
6. `Llm` service: provider registry (anthropic, openai-compatible) using the AI SDK
   with plugin-http fetch; tier resolution (fast/standard/strong with fallback);
   task routing table with per-task override and escalation flag; generic
   validate -> repair -> escalate loop for `object` calls; `llm_calls` accounting
   with task, tier, escalated, validation_ok; test-connection call.
7. Settings UI: providers (add/edit/test), tiers, task routing table, Jira (URL,
   PAT, test shows display name), Confluence (URL, PAT, test), data location.
8. App shell: sidebar navigation for all routes (empty pages), command palette,
   theme toggle, toast provider.
9. Tooling: `bun run dev`, `bun run tauri dev`, `bun run typecheck`, `bun test`,
   `bun run lint` (biome or eslint), `bun run db:generate`.

Checklist
- App launches; settings persist across restart; secrets are absent from the store
  file and from logs.
- Jira and Confluence test buttons succeed against the user's instances.
- LLM test call returns text and records a `llm_calls` row with tier and task.
- With only one tier configured, all tasks resolve to it; with three, each task
  resolves to its default.
- `bun test` runs at least one test per service skeleton.

## Phase 1: Jira sync and ticket browser (FR-1)

Tasks
1. `JiraClient` service: thin typed client on `ky` with the plugin-http fetch and
   bearer auth (design.md D11), covering the endpoints in design.md section 5 with
   zod-validated responses. Contract tests with recorded fixtures.
2. Field discovery for Epic Link, Epic Name, Sprint; override in settings.
3. `Sync` service: scope JQL + tracked epics, incremental with watermark, paging,
   upsert issues and comments, weekly full resync, stale marking, status indicator,
   timer while the app is open.
4. Tickets page: TanStack Table tree Epic -> Story/Task -> Sub-task, filters, FTS or
   LIKE search, detail drawer (fields, wiki-rendered description, comments, links).
5. Manual actions: comment, transition, edit fields, set parent/epic link. Each goes
   through the `Executor` write path so re-fetch and `actions_log` apply.
6. Markdown <-> wiki markup conversion helpers with tests.

Checklist
- Full scope syncs; incremental sync picks up a change made in Jira within one
  cycle.
- Creating a comment from the app appears in Jira; the app shows Jira's version.
- 2,000 issue cache renders the tree in under 1 second.

## Phase 2: Organisational context (FR-4)

Tasks
1. Teams and People CRUD pages with profile editor (communication profile as a
   structured form plus free notes).
2. Match contacts to Jira users by username when syncing (assignee/reporter names
   become links to contacts).
3. `ConfluenceClient`: search (CQL and free text), get page, import as
   `context_notes` via turndown, "open in browser" via opener plugin.
4. Context notes list on team, person and ticket detail.
5. JSON import/export of teams and people (Could, small).

Checklist
- Search a Confluence page, import it, see Markdown attached to a team.
- A Jira assignee name links to the matching contact.

## Phase 3: Intake, proposals, execution (FR-2, core of the product)

Tasks
1. `Retrieval` service: reference extraction, FTS/LIKE candidates, recency, directory,
   dependencies, memories; token budgeting; deterministic block ordering.
2. `Intake` service as decomposed in design.md 7.3: deterministic preprocessing
   (reference extraction, quote/signature stripping), `segment_input` for long
   inputs, per-item retrieval snapshot stored on the item, `classify_item` with
   `ItemResultSchema` whose targets and enums are built from the candidates,
   code validation against candidates and create metadata, repair, escalation,
   dedupe and `$new` merging, persistence of inbox item, items and proposals.
3. Inbox page: intake box (text, sender picker, source), streaming or spinner,
   proposal cards with edit forms per kind, approve/reject/approve-all, result
   states, history list.
4. `Executor`: sequential execution, `$new:n` placeholder resolution, per-kind
   handlers (Jira create/update/comment/transition, dependency link, person/team
   update, remember), re-fetch, `actions_log`, correction capture into `memories`.
5. Dashboard quick intake box reusing the same component.
6. Tests: schema round-trip with canned outputs; validation rejects out-of-candidate
   targets; repair path with invalid output; executor mapping fixtures; placeholder
   resolution; correction capture.
7. Committed eval set: five to ten sanitised sample inputs with expected proposals
   under `src/test/eval`, runnable against a live model behind an env flag.

Checklist
- Paste each of the user's sample messages; proposals are sensible; approve creates
  or updates the right issues; nothing is written before approval.
- A rejected proposal creates an `example` memory with before/after.
- The same sample inputs run on the fast tier and the standard tier produce the
  same proposal kinds and targets on the explicit, single-item cases.

## Phase 4: Dependencies and follow-ups (FR-3)

Tasks
1. Dependency CRUD from ticket detail and from `link_dependency` proposals.
2. Waiting page grouped by owner, overdue first; follow-up timeline; mark resolved.
3. Optional Jira remote link mirroring per dependency.
4. Follow-up reminders: scheduler in-app; OS notification via plugin when due.

Checklist
- Overdue dependency appears on Waiting page with correct day count.
- Remote link visible in Jira when mirroring is enabled.

## Phase 5: Dashboard and scoring (FR-5)

Tasks
1. `Scoring` pure module with weights from settings; unit tests for each factor and
   for reason strings.
2. Dashboard sections (FR-5.1) as cards with "why here" popovers; pin, snooze,
   override actions writing `issue_meta`.
3. Epic health rollup per tracked epic.
4. `Brief` service and panel with regenerate; cache invalidation on data change.

Checklist
- Changing a weight in settings reorders Top focus predictably.
- Brief mentions overdue dependencies and due-soon items present in the data.

## Phase 6: Communication drafting (FR-6)

Tasks
1. `Comms` service: prompt with recipient profile, team function, linked tickets,
   dependency history, last 3 communications, memories, output language.
2. Drafts page: composer (intent, recipient, tickets, dependency, notes), short and
   standard variants, edit, regenerate with instruction, copy to clipboard, mark
   sent -> `followups` row on the dependency.
3. "Draft a chase" button on Waiting page and on dependency cards pre-fills the
   composer.

Checklist
- Two contacts with opposite profiles yield clearly different tone.
- Marking sent updates `last_followup_at` and the Waiting page.

## Phase 7: Learning, memory and chat (FR-7, FR-8)

Tasks
1. Memory page: CRUD for rules/facts/preferences; examples list with provenance;
   weight adjustments; delete.
2. Retrieval ranking of memories (relevance via FTS on content + subject match,
   weight, recency, use_count); `last_used_at` updates when included in a prompt.
3. Consolidation: group examples, ask the strong tier for rules, present as proposals.
4. Chat page: AI SDK tool loop with read tools and `propose` write tool; step limit;
   streaming UI; tier picker.
5. Evaluation replay (FR-9.4): settings page action that replays executed inbox
   items on a chosen tier or model from their stored retrieval snapshot and shows
   agreement rates per proposal kind.

Checklist
- Two corrections of the same kind make the third similar input classify correctly.
- Chat can answer "what am I waiting on from team X" from local data and can turn
  "comment on ABC-12 that we are blocked" into a pending proposal.

## Phase 8: Hardening and packaging

Tasks
1. Tighten http capability scope to configured hosts; CSP review; log redaction test.
2. Database export/import; reset cache; error toasts with retry paths audited.
3. Offline behaviour: cached browsing works with network off; writes fail fast with
   a clear message.
4. `bun run tauri build` for Linux; CI workflow for typecheck, tests and build on
   Linux, Windows, macOS.
5. Update `README.md` with setup, permissions needed in Jira/Confluence, and a
   troubleshooting section.

Checklist
- Fresh machine install from the built bundle reaches a working dashboard within
  the Phase 0 setup steps.
- No secret string appears in the log file or the export.

## Working agreements for the executor

- Prefer adding a shadcn component via the CLI over writing a new component.
- Every Jira or DB write goes through `Executor`; UI never calls `JiraClient`
  directly for writes.
- Keep LLM output schemas in `src/prompts` next to their prompt builders; version
  them when changed and keep old canned outputs parsing in tests.
- When a decision in `design.md` proves wrong, change the doc first, then the code.
- Ask the user only for the items listed at the top; otherwise choose sensible
  defaults and note them in `docs/CHANGELOG.md`.
- Git: commit after every green task on the phase's feature branch, squash into
  coherent commits when the phase checklist passes, merge to `main` locally, and
  never mention Claude, Anthropic or AI assistance in commit messages or trailers.
  Full rules in `../CLAUDE.md`, section Git workflow.

---

# Part 2: Small asks (Phases 11–16)

Approved 2026-10-03. What: requirements.md FR-10 to FR-13 and the additions to FR-2
and FR-3. How: design.md D44–D50; where this plan and a decision differ, the decision
wins, and where a decision proves wrong, change the decision first. Phases 9 and 10
were the cleanup and the sprint planner (see CHANGELOG.md).

All phases land on `feat/11-small-asks`, one squashed commit per phase. Order:
11, 14 and 15 may run side by side; then 12, then 13, then 16.

Rules for every phase
- The hard rules in `../CLAUDE.md` hold. In particular: a Jira write that comes from
  pasted or typed input is a proposal the user approves; a write the user makes with
  a button (Done, snooze, resolve) goes through the `Executor` as the ticket view's
  actions do; UI never calls `JiraClient` write methods.
- The model picks from lists the code built. Every new field in the classify output
  follows the portable schema (D21): flat, nullable as "(none)", enums from
  candidates, checked in code, repair on failure.
- Stored data keeps parsing: new payload fields have defaults; schema changes are
  drizzle migrations (`bun run db:generate`); settings fields use `.prefault`/defaults.
- Tests with each task: unit tests for pure logic, service tests over the in-memory
  Db and fixture fetch, scripted-model tests for prompts, and eval cases in
  `src/test/eval/cases.ts` for each new intake behaviour. `scripts/mock-jira.ts`
  learns each new endpoint.
- Done means `bun run typecheck`, `bun test` and `bun run lint` are green, the
  phase's checklist is covered by tests where a test can cover it, and
  `docs/CHANGELOG.md` has the phase's entry (built, decisions and defaults, known
  limits). Say plainly what was not verified, above all anything only a running
  desktop app can show.

## Phase 11: Small-asks home (FR-10, D44)

Tasks
1. Settings `smallAsks { projectKey, label, joinActiveSprint }` and a Small asks
   section in Settings: project picker from the synced projects, label, sprint
   switch, and on save a check of the create metadata that lists required fields the
   app cannot fill.
2. Canonical `create_issue` payload: `labels`, `smallAsk`, `requesterPersonId`,
   `joinSprint`. Jira mapping sends labels. Old proposals still parse.
3. Classify (new prompt version): the `smallAsk` field and the rule for when an ask
   is a small ask; `requesterPersonId` from candidate people; mapping to the
   canonical payload applies the home (project, label, assignee, sprint flag, type
   default, requester from the thread's sender first) and appends the "Asked by"
   line and quoted evidence to the description.
4. Executor: after the create, store `issue_meta.requester_person_id` (migration)
   and, when `joinSprint`, move the issue into the active sprint chosen at execution
   time; a failed move is a warning on an executed proposal.
5. Inbox: the compact Track row for a small-ask create and the pending proposals of
   the same item that target its `$new` ref; type and epic selects (reuse the pickers
   of the proposal edit dialog); Track approves in order; expand shows the cards;
   row changes are recorded as edits. The one-time hint when no home is set.
6. Eval cases: an ask with no ticket (small ask), an ask that belongs to a candidate
   story (sub-task), planned work (not a small ask), an ask with a sender (requester).

Checklist
- With a home set, the FR-10 AC passes against the mock Jira: one row, one click,
  ticket in the home project with label, assignee, sprint, due date and requester.
- With no home set, existing intake tests pass unchanged.
- A proposal stored before this phase still loads, edits and executes.

## Phase 12: Jira links and blocker wake-up (FR-3.8, D45)

Tasks
1. Jira client: `GET /issueLinkType`, `POST /issueLink`, `DELETE /issueLink/{id}`;
   sync stores the "blocks" type in `jira.linkTypes`. Mock Jira serves them.
2. Proposal kind `link_issues` end to end: canonical schema, classify field and rule
   ("when X is done", "after X ships", "blocked by X"), validation (distinct, both
   candidates, not already linked), Executor with the direction check, proposal card,
   compact row inside a Track bundle.
3. A key named in the text but missing from the cache is read once and offered as a
   candidate.
4. Post-sync blocker step: `jira.blockers` map, `issue_meta.open_blockers`,
   `unblocked_at`, `unblocked_by` (migration); readers of block state use the map.
5. One notification per newly unblocked ticket in the reminder loop.
6. Eval cases: "once PLAT-1 is deployed tell the vendor" (small ask blocked by
   PLAT-1), an existing ticket blocked by another.

Checklist
- FR-3.8 AC passes in a service test: link created, blocker closed in the mock, next
  sync sets `unblocked_at` and one reminder is due; a reopened blocker clears it.
- The direction check is tested with a mock that stores the link reversed.

## Phase 13: Waits: update from intake, away dates (FR-3.6, FR-3.7, D46, D47)

Tasks
1. Retrieval: open dependencies as candidates (sender, sender's team, candidate
   tickets, wording), capped, in the prompt with id, ticket, label, owner and dates.
2. Proposal kind `update_dependency` end to end, executing through the dependency
   functions the Waiting page uses; no duplicate `link_dependency` for a listed wait.
3. `people.away_until` (migration), the field on the person form and a badge;
   `update_person.awayUntil`; the classify rule for out-of-office text.
4. Dependency timing with the owner's away date (pure, unit-tested): asleep, then
   "is back"; used by the Waiting page, reminders, scoring and the chat's
   `waiting_on` tool. The draft prompt and the draft composer know the recipient is
   away.
5. Eval cases: an answer that resolves a wait, a partial answer that logs a reply,
   an out-of-office reply that sets the away date.

Checklist
- FR-3 AC passes: "Bob sent the numbers" from Bob proposes resolving Bob's wait.
- A wait whose owner is away until tomorrow is not due today and is due, with the
  reason, on the first working day after.

## Phase 14: Quick capture and tray (FR-11, D48)

Tasks
1. Rust: global-shortcut and single-instance plugins, tray icon with Open, Capture
   and Quit, hide on close when the setting is on and the tray exists, Dock reopen on
   macOS, `--capture` forwarded from a second launch. Capabilities updated.
2. Settings `capture { shortcut, closeToTray }` with a Capture section that shows
   whether the shortcut and tray are available and, if not, why and what to do
   (`secretary --capture` bound in the desktop's own shortcuts).
3. The Capture dialog (the Inbox composer in a shadcn Dialog) mounted at the app
   root; opened by Ctrl+K "Capture", the tray, the shortcut and `--capture`; submit
   files the thread, triages in the background, re-hides the window when capture
   showed it, and notifies when a hidden capture ends with pending proposals.
4. README: the tray library on Linux, the shortcut, the Wayland binding.

Checklist
- `cargo check` passes; typecheck, tests and lint are green; a test covers the
  capture submit path and the open-capture event.
- The window controls of D36 still close, minimise and maximise correctly with the
  setting on and off (by code review; state what was not run).

## Phase 15: Navigation (FR-13, D50)

Tasks
1. Sidebar: Today, Inbox, Tickets, Waiting on, Sprint, Chat, Context.
2. `/sprint` with tabs Plan, Report and Epics (the epic health rollup moves here);
   `/context` with People, Teams and Memory; tab as a search parameter; redirects
   from `/planning`, `/report`, `/people`, `/teams`, `/memory`; every link in the app
   and in the command palette updated.
3. The draft composer as a Sheet opened from a ticket, a dependency (chase), a
   person and Ctrl+K; `/drafts` kept; setting `general.draftsInSidebar` (default
   off).
4. Settings: an Advanced tab with task routing, ranking weights and evaluation
   replay.

Checklist
- Every old path lands on the right tab; no dead link (`grep` for the old paths).
- Route tests or component tests cover the redirects and the tab parameter.

## Phase 16: Today and the sweep (FR-12, D49)

Needs Phases 11, 12, 13 and 15.

Tasks
1. `buildToday` replacing `buildDashboard`, with unit tests for each list, the
   ordering rules, sleeping waits, woken tickets and the 2,000-issue timing.
2. The Today page: capture box, three lists, header counts, brief button, plan
   banner; row actions (Done, snooze presets, draft, log reply, resolve) through the
   Executor and the dependency functions.
3. The sweep dialog with its keys and the weekly stale pass.
4. Chat: `pending_decisions` lists open small asks with requester, age and state;
   `waiting_on` shows blockers and away owners.
5. Remove what Today replaces: the old dashboard sections and the prompts card on
   the dashboard (the chat keeps suggested prompts).

Checklist
- FR-12 AC passes; each list has a test for a fixture that mixes small asks, waits,
  blockers and sprint work.
- Done on a small ask transitions it in the mock Jira and the row leaves the list.

## Phase 17: Revoke an approval (FR-14, D54)

Needs Phases 11 to 16. Branch `feat/17-revoke`, stacked on `feat/11-small-asks`.

Tasks
1. Undo data: each Executor path records `undo` in the proposal result as D54 (1)
   lists, read just before the write; tests per kind against the stubbed Jira.
2. Reverse actions in the Jira client and the Executor: delete issue, my-permissions
   check, delete comment, move to backlog, plus the existing transition, field
   update, assign, sprint move and link deletion; the cancel-status choice as a pure
   function with tests (cancelled/canceled, won't do, rejected, declined, then done).
3. A pure revoke planner (`src/services/proposals/revoke.ts`): steps per kind, the
   cascade from a create to what acts on it, impossibility reasons, the
   "changed since" check; unit tests for every kind and the cascade.
4. `Proposals.revokePlan` and `Proposals.revoke`, status `revoked`, `revokeError`,
   resumable runs; the cache follows (deleted rows removed, others refreshed).
5. UI: Revoke on executed proposal cards and on tracked small-ask rows, a
   confirmation dialog listing the steps (shadcn AlertDialog), the revoked badge and
   message, warnings and the retry path; disabled with the reason when impossible.
6. Mock Jira: delete issue, delete comment, my-permissions (with a switch for a user
   without delete permission), backlog moves, and a cancelled status in a workflow.

Checklist
- FR-14 AC passes against the mock Jira, both with and without delete permission.
- Every kind has a revoke test; a field changed in Jira after approval is kept and
  named in a warning; a failed step leaves the proposal resumable.
- typecheck, lint, tests and cargo checks pass; CHANGELOG has the phase entry.

## Phase 18: Story points on proposals (FR-15, D55)

Needs Phase 17. Branch `feat/18-story-points`, stacked on `feat/17-revoke`.

Tasks
1. Schema and settings: `storyPoints` and `storyPointsEstimated` on create_issue,
   `storyPoints` in update_issue changes, `smallAsks.defaultPoints`; describePayload
   and the payload mapping; unit tests.
2. Scale from the cache as a pure query with tests (projects in play first, top 8 by
   frequency, ascending).
3. Classify prompt version 12: the scale section, the `storyPoints` and
   `pointsSource` output fields, the rules (use stated points; estimate only new
   tickets and only from the scale; never re-estimate an existing ticket), and code
   validation with repair messages; the small-ask default in payload building.
4. Jira client `editMetaFields(key)`; the Executor picks the field from create or
   edit metadata, writes the number, warns or fails as D55 says; update_issue undo
   records the previous points and revoke restores them.
5. UI: Story points in the edit dialog, on the small-ask row (saved at once) and on
   cards ("suggested" while estimated); the default in Settings > Jira > Small asks.
6. Mock Jira: the story point field on create screens (not Epic or Sub-task),
   editmeta, values stored on create and update.
7. Live eval cases: stated points on a new ticket, a suggestion from the scale, and
   "is more like a 5" on an existing ticket.

Checklist
- FR-15 AC passes against the mock Jira.
- Validation rejects estimates outside the scale, stated points not in the input,
  and estimates on existing tickets.
- typecheck, lint, tests and build pass; CHANGELOG has the phase entry.

## Phase 19: Inline pasted text in the message box (FR-2.8, D56)

Branch `feat/19-inline-paste` from `main`.

Tasks
1. Composer on TipTap (plain-text schema, `pasted` mark, paste handler, unmark
   button and Ctrl/Cmd+Shift+O, Enter/Shift+Enter, Ctrl+W, disabled
   while busy, placeholder). `ComposerMessage` becomes ordered parts; every caller
   (inbox new thread, thread reply, quick thread, capture dialog) follows.
2. `splitMessage` and `partsOf` for inline runs, with unit tests: standalone paste,
   inline paste, several of each, multi-line paste inside a line, « » in user text,
   old block-first messages.
3. Prompt version 13: inline «…» in instructions and the rule; unit tests on the
   rendered prompt.
4. Thread view renders user parts in order with the highlight.
5. Live eval: a reply "change the summary to «…»" where the paste holds an
   instruction-like sentence; the summary changes and nothing else is proposed.

Checklist
- Pasting inside a sentence keeps it there; the model gets one sentence with «…».
- A pasted message on its own lines is still classified as input.
- typecheck, lint, tests and build pass; CHANGELOG has the entry.

## Phase 20: New tickets and the sprint (FR-16, D57)

Needs Phase 18 (story points). Branch `feat/20-sprint-fit`, stacked on
`feat/18-story-points`.

Tasks
1. Settings: `sprint.daysPerPoint` (number or null) with the zod schema and a
   Settings > General > Sprint field that shows the derived rate when empty.
2. `sprints/fit.ts` (pure, tests): working days left, load, rate (setting, else
   velocity on the board, else none), verdict (fits, tight, over, unknown), the
   headline and detail lines. Cover: today is the last day, the end has passed, no
   rate, unestimated tickets, a ticket without points, another assignee, other
   creates of the thread joining.
3. Payload: `joinSprintChosen`; `joinSprint` for every create (small ask from the
   setting; otherwise due on or before the sprint end; never Epics or sub-tasks);
   revisions and re-triage keep a chosen value. Correction examples leave
   `joinSprint` out.
4. `sprints/fit-query.ts` and a TanStack Query hook per thread, invalidated after
   sync and proposal edits; the same sprint pick as the Executor.
5. UI: the switch with its verdict line and Details popover on the create card,
   the chip on the small-ask row, the switch in the edit dialog (saved at once
   through `Proposals.saveEdit`), executed cards showing the result; the Today
   Sprint work header line; the chat `sprint_points` additions.
6. Mock Jira: whatever the AC needs (a sprint with dates and the user's tickets in
   it, the move into the sprint on create).

Checklist
- FR-16 AC passes against the mock Jira.
- Fit tests cover the cases in task 2; payload tests cover the defaults and the
  chosen value surviving a revision.
- No change to the classify prompt or its version.
- typecheck, lint, tests and build pass; CHANGELOG has the phase entry.

## Phase 21: Edit an existing ticket (FR-17, D58)

Branch `feat/21-ticket-edit`, stacked on `fix/fiscal-year-setting` (PR #30, for
`onSelect`).

Tasks
1. Executor: `update_fields.labels` (mapping, mock Jira); `run` picks the
   story point field from the edit screen when a user action leaves
   `pointsField` out, with an error worded for the ticket view.
2. Move the points parsing out of `small-ask-row.tsx` into a shared module with
   tests; parse labels (spaces or commas, deduplicated) in a pure helper with
   tests.
3. Sprint options (pure, tests): Backlog, open sprints whose board shows the
   project (else all open), active first, the current one matched by name, a
   closed current sprint not pickable; Epics and sub-tasks get none.
4. Fit for an existing ticket joining the active sprint: a query in
   `sprints/fit-query.ts` reusing `sprintFit`, and a hook; the dialog shows
   D57's `VerdictLine` and `FitDetails`.
5. Edit dialog: the new fields, one Save that runs the changed writes in order
   and reports a partial failure; Details tab Story points row.
6. Tests against the mock Jira for the FR-17 AC.
7. The ticket's team (FR-17.5, D59): discovery, override, migration, sync
   mapping (object, string, bare id), Details row and Edit dialog line with the
   Context link; mock Jira gets a Team field.
8. Editing the team (D59): `team_id` column and migration, sync keeps the id,
   `update_fields.team` in the Executor and mapping, the JQL autocomplete search
   in `JiraClient` and the mock Jira, the Team combobox in the Edit dialog;
   tests for the mapping, the option list and the search parsing.

Checklist
- FR-17 AC passes against the mock Jira.
- Unit tests cover task 2 and 3 and the Executor's points field pick for a user
  action.
- typecheck, lint, tests and build pass; CHANGELOG has the phase entry.

## Phase 22: New contacts and teams from intake and chat (FR-18, D60)

Branch `feat/22-create-contacts` from `main`.

Tasks
1. Schema: `create_person`, `create_team` proposal kinds with `$person:n` and
   `$team:n` refs; refs accepted where person and team ids go; `update_person`
   gains `team`. Tests.
2. Classify: flat schema fields and enums, the rule in the prompt, version 14,
   code validation (refs defined earlier, email, Jira user from the snapshot,
   duplicates against Context and within the item) with repair. Tests.
3. Executor: inserts through the Directory queries, duplicate check at approval,
   ref resolution for the proposals that use them, undo data. Revoke: dependents
   first, then delete when unchanged and unreferenced. Tests, including mock-Jira
   free service tests for the whole thread.
4. UI: cards, edit dialog fields (team select with the thread's new teams),
   executed cards linking to Context; chat `propose_actions` description.
5. Eval cases (explicit add, team plus contact, unknown named owner, existing
   contact not duplicated, bystanders in pasted text) and a live run on the eval
   model.

Checklist
- FR-18 AC passes in service tests.
- The live eval passes the new cases and keeps the old ones.
- typecheck, lint, tests and build pass; CHANGELOG has the phase entry.

---

# Part 3: The work model (Phases 23–28)

Approved 2026-10-18. What: requirements.md FR-19. How: design.md D61; the picture
is `docs/work-model-plan.html`. Where this plan and the decision differ, the
decision wins, and where a decision proves wrong, change the decision first. The
rules for every phase in Part 2 hold. Each phase is its own branch from `main`,
`feat/<phase>-<topic>`, with a PR and the user's manual test before it merges.
Order: 23, then 24, then 25 and 26, then 27, then 28.

## Phase 23: Work items, events, state and questions (FR-19.1 to FR-19.4, D61)

Branch `feat/23-work-model` from `main`.

Tasks
1. Schema: `work_items`, `work_item_issues`, `work_events` (one migration); zod
   for the state shape and the event kinds in `services/work/schema.ts`; a `work`
   settings section (enabled, questions per day, state calls per day, group size
   cap). Tests.
2. Grouping: pure `services/work/grouping.ts` (active tickets, strong and weak
   edges, the cap, stability against existing items and corrections) and
   `services/work/queries.ts` to apply it; a run after each sync. Unit tests with
   fixtures: an epic with two active stories and a sub-task; two tickets linked by
   blocks; a thread naming two tickets; a 12-ticket epic not merged; a split kept
   on the next run.
3. Events: append points in Intake, the Executor, the sync upsert (the diff),
   Comms, the dependency queries, the ticket sheet (opened, edited) and the chat;
   attachment in code; `attach_event` prompt, schema and validation in
   `src/prompts/attach-event.ts`. Service tests over the in-memory Db: every kind
   arrives once; attachment by key, thread and wait; an ambiguous paste becomes a
   question and waits unattached.
4. State: `update_work_state` prompt and schema (`src/prompts/work-state.ts`),
   the derived-facts builder, validation, repair and the needs-look fallback; the
   pass (`services/work/pass.ts`: debounced, budgeted, the current item first,
   nothing when nothing changed); a user-edited note kept. Scripted-model tests: a
   date moved; a commitment from a paste; an invented person rejected; a kept note.
5. Questions: one `work` thread per item for `needs_clarification`, the ration,
   the answer path through `Intake.reply` to attachment or grouping, expiry. Tests.
6. UI: the Work tab in the ticket sheet (status note with edit, tickets, timeline,
   rename, split, merge, move a ticket); Today rows name their item and the current
   item comes first; Settings > Secretary with the `work` fields. No Jira write
   anywhere in this phase.
7. Eval: `src/test/eval/work-cases.ts` with event sequences and the expected state
   fields, runnable on the eval model like the intake eval; the FR-19 AC (Phase 23
   part) as a mock-Jira test.

Checklist
- The FR-19 AC (Phase 23 part) passes against the mock Jira.
- Grouping, attachment and state validation are unit-tested; the state eval passes
  on the eval model.
- A sync with no change makes no model call; the pass respects the daily budget.
- typecheck, lint, tests and build pass; CHANGELOG has the phase entry.

The user's manual test: with the real Jira, after one sync, the Work tab on an
in-progress ticket shows a sensible group and status note; pasting a teammate's
message about it updates the note without a new item; a paste about two tickets at
once asks which.

## Phase 24: Intake and chat read the state (FR-19.5, D61)

Branch `feat/24-work-reads` from `feat/23-work-model`. Everything that already
decides something for the user reads the work model first: classify sees the
state of the items an input touches before the candidate tickets, the chat
answers "where am I" questions from the state and the event log, and the brief
and the report draw on the same facts. No new Jira writes, no new tables.

### Tasks

1. **The `work` block in the retrieval snapshot.** `ItemSnapshot` gains
   `work?: WorkItemSnapshot[]` (prompt version 15), filled by `Retrieval.snapshot`
   from `services/work/queries.ts` for the items reached by: the keys the input
   names, the thread's tickets, the sender's open waits, the named contacts' open
   waits, and the current item when the input is the user's own words and names
   nothing. At most 3 items, the current item first. Each entry: `id`, `name`,
   `goal`, `currentStep`, `nextExpected`, `keys` (with status), `waits` (open, with
   owner name, label, expected date and the wait id so `update_dependency` can pick
   it), `commitments` (open, with to-whom and due), `lastEvents` (5, one line each,
   pasted text excerpted and marked untrusted), `needsLook`. Token budget
   `BUDGETS.work = 1200`; older snapshots without the block replay as they ran.
2. **Classify reads it.** `src/prompts/classify.ts`: render the block as
   "## The user's work" before the candidates, one item per paragraph in the form
   "PAY-12, PLAT-812: cert renewal. Now: waiting on Platform for the cert (Sarah),
   expected 17 Oct. Promised Dana an ETA by 15 Oct." Rules added to the system
   prompt: an input about a person, a thing or a date that matches an open wait
   of a listed item is a change to that wait (`update_dependency` on its id), not
   a new `link_dependency` and not a new ticket; an input that reports progress on
   a listed item's ticket is an `add_comment` or a transition on that ticket, not
   a create; the candidates list is for tickets the work block does not cover.
   Validation unchanged. `CLASSIFY_PROMPT_VERSION = 15`.
3. **Chat tools.** `work_items` (read): `list` (active items, current first:
   name, goal, current step, next expected, open commitment count), `item`
   (one item by id, key or name: state, tickets, open waits, commitments, the
   timeline's last 20 events), `changes` (events since an ISO time or "this
   morning"/"yesterday" resolved by code, across items or for one). `note_work`
   (write, local only, D17): records a `note` event with the user's words on the
   item that the text's keys or the named item reach (asks through the normal
   chat answer when none or several), sets `current` when the user says they are
   on it, and requests a work pass. The chat system prompt (`src/prompts/chat.ts`)
   says: for "where am I", "what changed", "what did I promise", "what's next on"
   use `work_items` before `search_tickets`; for "I'm on X now" and "note that"
   use `note_work`; the model never invents state it did not read. `my_focus`
   stays and adds the current item's name.
4. **Brief and report.** `BriefFacts` gains `work`: the current item (name, current
   step, next expected), items whose next expected date is today or past, and
   open commitments due today or past, each with the item name; the brief prompt
   lists them under "Your work" and must mention overdue commitments by name. The
   report's facts (`services/report/facts.ts`) gain, for each ticket in the
   period, its item's name and goal, so `by_epic` and `talk_track` group by work
   item when the ticket has no epic and name the goal in the first line. No new
   model call in either.
5. **Eval and tests.** `src/test/eval/cases.ts` gains (prompt v15) "Sarah says
   the cert will be Friday now" with the PAY-12 item in the work block →
   `update_dependency` on the existing wait with the new date and no
   `link_dependency` or create; "PLAT-812 is done, picking the cert up" →
   `add_comment`/`transition_issue` on PAY-12, no create; a control case with an
   empty work block that still proposes `link_dependency`. Unit tests: the work
   block's selection and budget; classify prompt rendering with and without the
   block; `work_items` and `note_work` outputs on a seeded db; brief facts with an
   overdue commitment; report grouping by item.
6. **Docs.** D61 "Built (Phase 24)" tail; CHANGELOG entry; design.md 7.2 budget
   row and section 8 chat tools line.

### Checklist

- [ ] `bun run typecheck`, `bun test`, `bun run lint`, `bun run build` green
- [ ] Live eval on the configured model: the three new cases pass and the old
      ones keep their score
- [ ] Rick: paste "Sarah says the cert will be Friday now" with PAY-12 waiting on
      Sarah → one `update_dependency` card on the existing wait; ask the chat
      "where am I on the cert?" → the state in prose, no ticket search; "I'm on
      PAY-12 now" → the Work tab shows it current and the note on the timeline;
      the morning brief names an overdue commitment.

## Phase 25: Consequence rules and outcome cards (FR-19.6)

Proposal bundles (`bundle_id`, `bundle_kind`), the outcome card with steps the user
can leave out and one Approve, the first five rules with switches and the per-item
quiet list, run from the pass.

## Phase 26: Playbooks and standing instructions (FR-19.7)

"Waiting on someone" first: live lookup of their ticket, comment, link or status,
mirror by default, follow-up, request draft; Settings > Secretary standing
instructions; teams and people gain `jiraProjects`. Then wait resolved, chase due,
ticket done.

## Phase 27: Suggestions where the user is (FR-19.8)

The Work tab and Today show next moves; new input is triaged against the current
item; parking with a reason.

## Phase 28: The end-of-day pass (FR-19.9)

What changed per item, what is due tomorrow, the unsettled questions, once a day.


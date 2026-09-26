# Secretary: Implementation Plan (handover to Claude Opus 5.5)

> **Status:** All phases are built. This plan is history; later changes are
> decisions D19–D28 in design.md section 12 and entries in CHANGELOG.md.

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

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

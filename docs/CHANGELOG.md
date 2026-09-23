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

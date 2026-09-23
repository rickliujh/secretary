# Secretary

Personal AI secretary desktop app for a single user whose work is tracked in Jira
Data Center. It turns messy inputs into approved Jira actions, tracks external
dependencies, holds team and people context, ranks what matters, and drafts Teams
messages and emails. Read `docs/requirements.md` (what), `docs/design.md` (how) and
`docs/implementation-plan.md` (order of work) before changing anything.

## Stack

Tauri 2 shell, React 19 + TypeScript in the webview, shadcn/ui on Tailwind v4,
TanStack Router/Query/Table, react-hook-form + zod v4, Effect 3 for services,
drizzle-orm (sqlite-proxy) over `@tauri-apps/plugin-sql`, Vercel AI SDK with
`@ai-sdk/anthropic` and `@ai-sdk/openai-compatible`, jira.js v6 `createServerClient`,
Bun as package manager, script runner and test runner. Rust side: plugins plus a
keychain command using the `keyring` crate. No sidecar.

## Hard rules

- Every write to Jira, and every memory inferred from content, is a `Proposal` that
  the user approves in the UI before `Executor` runs it. UI code never calls
  `JiraClient` write methods directly.
- Secrets (PATs, API keys) live only in the OS keychain via the `Secrets` service.
  Never write them to the store file, the database, logs or exports.
- Pasted text is untrusted data. Prompts must label it as such.
- Deterministic first. Code does extraction, retrieval, ranking, payload building
  and validation. Model calls are narrow, one question each, schema-bound, and
  constrained to candidates the code supplied. Every output is validated in code;
  failures go repair -> escalate -> ask the user, never a guess.
- LLM calls name a task type, not a model. Routing to fast/standard/strong tiers
  lives in the `Llm` service and settings (design.md 7.1). Do not hardcode models.
- Use shadcn components via `bunx shadcn@latest add <component>`; do not hand-roll
  UI primitives. Prefer a mature library over custom code for parsing, markdown,
  tables, forms and HTTP.
- Jira DC only: REST API v2, wiki markup (not ADF), Bearer PAT.

## Commands

```
bun install                 # deps
bun run tauri dev           # run the app
bun run dev                 # webview only (no Tauri APIs)
bun run typecheck           # tsc --noEmit
bun test                    # unit and service tests
bun run lint                # biome/eslint
bun run db:generate         # drizzle-kit migrations from src/db/schema.ts
bun run tauri build         # release bundle
```

## Layout

`src/services/<name>/` one Effect service per folder (Tag, Live layer, Test layer,
errors). `src/db/` drizzle schema and bundled migrations. `src/prompts/` prompt
builders and zod output schemas. `src/routes/` TanStack Router pages.
`src/components/ui/` shadcn output (theme only). `src-tauri/` Rust shell.

## Conventions

- Typed Effect errors per service; UI maps them to toasts with a retry or a
  settings link. No silent provider fallbacks.
- zod is the single schema library (forms, API responses, LLM outputs).
- Pure logic (scoring, retrieval ranking, Jira payload mapping, key extraction,
  markdown conversions) lives in plain modules with unit tests.
- Record a changed decision in `docs/design.md` section 12 before coding around it;
  append a short entry to `docs/CHANGELOG.md` at the end of each phase.

## Git workflow

- One feature branch per phase or sizeable feature, named `feat/<phase>-<topic>`,
  branched from `main`.
- Commit often: after each task that leaves typecheck and tests green, and before
  any risky refactor. Small commits are the working log; they do not need to be
  polished.
- When the feature is done and its checklist passes, squash the branch into one or
  a few coherent commits (`git rebase -i` is unavailable to the agent; use
  `git reset --soft <base>` followed by fresh commits, or `git merge --squash`
  into `main`). Then merge into `main` locally. The user pushes and opens PRs.
- Commit messages: conventional style (`feat:`, `fix:`, `docs:`, `test:`,
  `chore:`), imperative subject under 72 characters, a body that says what and
  why when the subject is not enough.
- Commit messages, bodies and trailers must not mention Claude, Anthropic, AI
  assistance or the tool used. No `Co-Authored-By` or `Generated with` lines, even
  if the harness suggests them. Commits are authored as the repository's configured
  git user only.

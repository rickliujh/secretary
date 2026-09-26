# Secretary

A personal work secretary for people whose work lives in Jira. It runs on your own
machine as a desktop app and keeps everything local.

- **Inbox threads**: paste a Teams message, an email or meeting notes and say what you
  want. The secretary proposes Jira actions (comment, update, move, create, link an
  epic), dependencies to track, facts about people and drafts. Nothing is written until
  you approve it, and you can ask for changes in the thread ("priority High", "make it
  a sub-task of PAY-3").
- **Tickets**: a searchable tree of your synced Jira issues with details, comments and
  what each one waits on.
- **Waiting**: everything you are waiting on from people, teams and incidents, with
  follow-up reminders and one-click chase drafts.
- **Dashboard**: a ranked focus list, what is due, what others wait on you for, and a
  daily brief.
- **Drafts**: Teams messages and emails written in each recipient's style, grounded in
  the tickets and the dependency history. "Open in Teams" or "Open in email" fills in
  a Teams chat or a new message in your default mail app (no Microsoft sign-in); you
  press Send yourself.
- **People and teams**: who does what, how they like to be contacted, notes and
  imported Confluence pages.
- **Memory**: rules and preferences it follows, and the corrections it learns from.
- **Chat**: ask about your tickets, dependencies and contacts; ask for a change and it
  prepares proposals in the Inbox.

Works with Jira and Confluence **Cloud** and **Data Center**, and any model provider
with an Anthropic or OpenAI-compatible API (Claude, Gemini through a proxy, OpenRouter,
local models).

## Install

Download the build for your platform from the latest CI run on `main` (Actions -> CI
-> the `secretary-<os>` artifact): `.dmg` for macOS, `.msi` or `.exe` for Windows,
`.deb`, `.rpm` or `.AppImage` for Linux. Pull request runs do not build bundles.

Before you install:

- The bundles are not signed, so the OS warns you the first time.
  - macOS (Gatekeeper): right-click the app, choose **Open**, then **Open** again.
  - Windows (SmartScreen): click **More info**, then **Run anyway**.
- The macOS build comes from the `macos-latest` runner and runs on Apple Silicon only.
  On an Intel Mac, build from source.
- Downloading an Actions artifact needs a GitHub login, and artifacts expire after
  90 days. For an older commit, build from source.

### Build from source

You need [Bun](https://bun.sh), [Rust](https://rustup.rs) and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your OS. On Debian
or Ubuntu:

```sh
sudo apt-get install libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev \
  patchelf libssl-dev libdbus-1-dev pkg-config
```

Then:

```sh
bun install
bun run tauri build        # bundles in src-tauri/target/release/bundle/
```

## First run

Open **Settings** and work through the tabs.

1. **Providers**: add a model provider (Anthropic, or any OpenAI-compatible endpoint
   such as a local proxy, OpenRouter or Gemini's OpenAI endpoint) and its API key. Keys
   are stored in the OS keychain, never in files. Test it.
2. **Models**: bind the **fast**, **standard** and **strong** tiers to models. A fast,
   cheap model works well for fast and standard; strong is only used when a cheaper
   tier's answer fails its checks, and for rule suggestions.
3. **Jira**: your site URL. The type (Cloud or Data Center) is detected from the URL.
   - Cloud: your account email and an
     [API token](https://id.atlassian.com/manage-profile/security/api-tokens).
   - Data Center: a personal access token (Profile -> Personal Access Tokens).
   Set the sync scope (JQL) and any epics to track, test the connection, then run a
   **Full resync** once.
4. **Confluence** (optional): same site on Cloud reuses the Jira token.
5. **General**: output language, follow-up gap, and the month your fiscal year starts
   (so "the second sprint of Q3" means what your company means). If your network uses
   a proxy through a PAC file, choose **Manual** under Network and enter the proxy the
   PAC file returns.

### Permissions the secretary needs

It acts as you, so it can do only what your account can.

| Where | Needed for |
|---|---|
| Jira: Browse projects | Sync, search, chat |
| Jira: Add comments | Comment proposals |
| Jira: Edit issues, Assign issues | Updates, priority, due date, assignee, epic |
| Jira: Transition issues | Status changes |
| Jira: Create issues | New tickets and sub-tasks |
| Jira: Link issues | Mirroring dependencies as remote links (optional) |
| Jira Software: view boards | Sprint dates for the sprint calendar |
| Confluence: view the spaces you import from | Notes and chat search |

## Privacy and safety

- Data stays on your machine: a SQLite database, a settings file and logs in the app's
  data folder (Settings -> Data shows where).
- Tokens and API keys live only in the OS keychain. They are redacted from logs, error
  messages and exports.
- The app only talks to the Jira, Confluence and model hosts you configured; any other
  request is refused before it leaves the app.
- Pasted text is treated as untrusted: instructions inside a pasted message are never
  followed. Every Jira write is a proposal you approve.

## Troubleshooting

| Symptom | What to do |
|---|---|
| "error sending request" or "Can't reach Jira" | A company proxy is in the way. Settings -> General -> Network -> Manual, with the proxy your PAC file returns (on macOS: `scutil --proxy`, then open the PAC URL). TLS inspection certificates installed in the OS are trusted. |
| Jira says 401 | Cloud needs your account email plus an API token (not your password). Data Center needs a personal access token. |
| Jira Cloud search fails with 410 | Update: the old search endpoint was retired and the app uses the new one. |
| "The model's answer was not usable" | The model could not produce an answer that passed its checks. Bind a stronger model to the strong tier, or try another model. Settings -> Models -> Evaluation replay compares models on your own decided items. |
| Sprint positions ("sprint 2 of Q3") missing | Run a Full resync so each board's sprint history is read; your account needs to see the board. |
| Offline | Cached tickets, threads and drafts keep working; syncing and model calls resume when the network returns. |
| Tickets look out of date | Settings -> Jira -> Full resync, or Settings -> Data -> Clear Jira cache. |
| Something else | Settings -> Data -> Logs -> Show. Logs are redacted. |

Settings -> Data also exports everything (without keys) to one JSON file and imports
it again, saving a backup of your current data first.

## Development

```sh
bun install
bun run tauri dev           # the app
bun run typecheck && bun run lint && bun test
bun run mock:jira           # fake Jira Data Center on :8089 (--issues N)
bun run mock:confluence     # fake Confluence on :8090 (--cloud for the Cloud shape)
bun run db:generate         # migrations from src/db/schema.ts
```

The live evaluation runs the real intake, drafting and chat against a model:

```sh
SECRETARY_EVAL_KIND=openai-compatible \
SECRETARY_EVAL_BASE_URL=https://openrouter.ai/api/v1 \
SECRETARY_EVAL_API_KEY=... \
SECRETARY_EVAL_STANDARD_MODEL=z-ai/glm-5.3-flash \
bun test src/test/eval
```

Read `docs/requirements.md` and `docs/design.md` (decisions in section 12) before
changing things; `docs/implementation-plan.md` is the build history and
`docs/CHANGELOG.md` what changed since. `CLAUDE.md` has the working rules.

CI runs typecheck, lint and tests on every pull request. The release bundles, Rust
tests and clippy run on pushes to `main` and when the workflow is started by hand.

## License

GPL-3.0. See [LICENSE](LICENSE).

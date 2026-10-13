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
- **Today**: one page with a capture box and three lists. *Your move*: tickets whose
  blocker just closed, your small asks, new comments and mentions, Inbox threads
  with decisions. *Their move*: what you wait on, most pressing first, and your
  tickets blocked by others. *Sprint work*: your ranked sprint tickets with "due soon"
  and "at risk" badges. Rows act in place (Done, snooze, draft a reply or a chase,
  log a reply, resolve), and **Sweep** steps through what needs a decision from the
  keyboard (D done, N nudge, S snooze, X drop, Space skip). The daily brief opens
  from a button.
- **Drafts**: Teams messages and emails written in each recipient's style, grounded in
  the tickets and the dependency history. "Open in Teams" or "Open in email" fills in
  a Teams chat or a new message in your default mail app (no Microsoft sign-in); you
  press Send yourself.
- **People and teams**: who does what, how they like to be contacted, notes and
  imported Confluence pages.
- **Memory**: rules and preferences it follows, and the corrections it learns from.
- **Chat**: ask about your tickets, dependencies, contacts and your own notes; ask for a
  change and it prepares proposals in the Inbox.
- **Data sources**: connect Obsidian vaults (Settings -> Data sources) and the chat
  searches and reads your notes through Obsidian's command line interface
  (Obsidian 1.12.7+, turned on in Obsidian: Settings -> General -> Advanced).

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

### Quick capture and the tray

To file a message or a task without leaving what you are doing, open **Capture**:
Ctrl+K then Enter, the global shortcut (Ctrl+Shift+Space, Cmd+Shift+Space on macOS),
the tray menu, or `secretary --capture`. Paste or type, press Enter, and the dialog
closes; the secretary reads it in the background and puts the window back the way it
was. When something is waiting for your approval and the window is out of sight, a
notification says so. Change the shortcut, or turn it off, in Settings -> General ->
Capture and tray.

Closing the window keeps Secretary running in the tray, so sync, reminders and the
shortcut keep working; **Quit** is in the tray menu. On macOS closing hides the app the
way Cmd+H does: the Dock icon stays, and a Dock click, Cmd+Tab or the menu bar icon
brings the window back. Turn this off in the same settings card, and closing quits again.
Starting Secretary a second time brings the running window forward.

On Linux:

- The tray needs the AppIndicator library: `libayatana-appindicator3-1` on Debian or
  Ubuntu, `libayatana-appindicator-gtk3` on Fedora, `libayatana-appindicator` on Arch.
  GNOME shows tray icons only with the AppIndicator extension. Without the library
  the app runs without a tray, and closing the window quits.
- Wayland does not let apps register global shortcuts. Bind `secretary --capture` to
  a key in your desktop's own settings (GNOME: Settings -> Keyboard -> Custom
  Shortcuts; KDE: System Settings -> Shortcuts -> Custom Shortcuts). Use the full path
  of the AppImage if that is how you run it. The key opens Capture in the running app,
  or starts Secretary with Capture open.

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
- Notes stay in Obsidian; the chat sends a note to your model provider only when it
  searches or reads it for a question. Obsidian's "Excluded files" setting applies.
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
| No tray icon, or closing the window quits | Settings -> General -> Capture and tray says why. On Linux install the AppIndicator library (see Quick capture above) and, on GNOME, the AppIndicator extension. |
| The capture shortcut does nothing | Settings -> General -> Capture and tray shows whether it is registered. Another app may own the combination; pick another. On Wayland, bind `secretary --capture` in the desktop's keyboard settings. |
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
SECRETARY_EVAL_PROVIDER=deepinfra/fp4,streamlake/fp8,novita/fp8 \
bun test src/test/eval
```

Optional variables:

| Variable | Effect |
|---|---|
| `SECRETARY_EVAL_FAST_MODEL` | Also compares the fast and standard tiers on single-item cases |
| `SECRETARY_EVAL_CASE` | Runs only intake cases whose name contains this text (and skips the other live tests) |
| `SECRETARY_EVAL_CONCURRENCY` | Intake cases run at once, default 6; 1 runs them one after another |
| `SECRETARY_EVAL_EFFORT` | The provider's effort setting (`low` to `max`); unset is "Provider default", which sends nothing. OpenAI-compatible providers get it as `reasoning_effort` |
| `SECRETARY_EVAL_PROVIDER` | OpenRouter only: upstream providers in order, comma-separated, for example `deepinfra/fp4,streamlake/fp8,novita/fp8`. Requests go to the first and fall back down the list, never outside it (`provider.order` and `provider.only`); one slug pins that provider. Unset lets OpenRouter route |

Every intake case runs in its own in-memory database and prints a line when it
finishes (pass or fail, seconds, model calls). The run ends with each case's
result, then wall time, model calls, tokens, the five slowest cases and how many
responses each upstream provider served, so a fallback shows. The drafting, chat, planning, report and vault
tests run at the same time. If the first three cases all fail with the same
provider error (timeout, rate limit, server error), or any case gets 401/403, the
run stops and says what to check.

OpenRouter's default routing can land on a slow provider: a reasoning model then
spends over a minute per call and hits the app's 120 s timeout. Pin a fast provider
with `SECRETARY_EVAL_PROVIDER`, or add the `:nitro` suffix to the model
(`z-ai/glm-5.3-flash:nitro`, OpenRouter's fastest-provider routing), or lower the
effort with `SECRETARY_EVAL_EFFORT=low`. A pinned provider can also turn requests
away (429, "temporarily rate-limited upstream"). OpenRouter sends the app's
schema-bound requests only to listed providers that support structured outputs,
so it does not move down the list by itself; the eval does: after a 429 it asks
the rest of the list at once, and only when the last provider is busy too does it
wait with backoff (inside the app's timeout) and start again from the first. The
summary counts the 429s per provider, how many moved on and how many were waited
out. On a provider with
capacity a classify call answers in 10 to 20 s, so a full run should take a few
minutes, and it costs a few cents on GLM 5.3 Flash.

A debug build on Linux runs as its own instance, so `bun run tauri dev` starts beside
an installed Secretary instead of handing over to it. On macOS and Windows quit the
installed app first. Both builds use the same data folder.

Read `docs/requirements.md` and `docs/design.md` (decisions in section 12) before
changing things; `docs/implementation-plan.md` is the build history and
`docs/CHANGELOG.md` what changed since. `CLAUDE.md` has the working rules.

CI runs typecheck, lint and tests on every pull request. The release bundles, Rust
tests and clippy run on pushes to `main` and when the workflow is started by hand.

## License

GPL-3.0. See [LICENSE](LICENSE).

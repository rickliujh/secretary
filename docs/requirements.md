# Secretary: Feature Requirements

Status: approved for implementation. Date: 2026-09-23.
Owner: Rick Liu. Executor: Claude Opus 5.5 (see `implementation-plan.md`).
Now: built. Later changes to scope are decisions D19–D43 in `design.md` section 12.
Small asks (FR-10 to FR-13, and the additions to FR-2 and FR-3) were approved on
2026-10-03 and are built: decisions D44–D51, Phases 11–16 of `implementation-plan.md`.

## 1. Vision

A personal desktop AI secretary for one knowledge worker whose work is tracked in
Jira (Cloud or Data Center) as Epics, Stories and Tasks. The secretary keeps the
tracker up to date from messy inputs (pasted messages, spoken-style descriptions), tracks external
dependencies (people, teams, ServiceNow incidents), holds organisational context
(teams, people, personalities, Confluence pages), tells the user what matters most
right now, drafts outbound Teams messages and emails in the right tone for the
recipient, and improves from the user's corrections over time.

Since 2026-10-03 the first job is keeping track of **small asks**: the tasks that
pop up beside the main work (a message from a manager, an email asking for a change,
an answer to wait for, a request to send, a page to update), often with a condition
(when a ticket is done, when someone is back). Each one becomes a Jira ticket with one
click, comes back when its condition is met, and shows in one list (FR-10 to FR-12).

Principles, in priority order:

1. **Human in the loop for every outward write.** The secretary proposes; the user
   approves. No Jira write, no memory write inferred from content, without an
   explicit approve action in the UI. Reading and local drafting need no approval.
2. **Jira is the source of truth for tickets.** The local database is a cache plus
   a home for secretary-only data (dependencies, notes, people, memories).
3. **Local first, private.** All data lives on the user's machine. Secrets live in
   the OS keychain. Only the configured LLM endpoints, Jira and Confluence hosts are
   contacted.
4. **Mature libraries over handrolled code.** See `design.md` for the stack.
5. **Deterministic first, model second.** Code does everything it can do reliably:
   reference extraction, candidate retrieval, ranking, payload building,
   validation. The model only makes judgments code cannot, in narrow, schema-bound
   steps. Behaviour should degrade gracefully, not change character, when the
   configured model changes.

## 2. Users and environment

- Single user, desktop (Linux first, Windows and macOS builds expected to work).
- Jira Data Center (self-hosted, REST API v2, Personal Access Token as Bearer) or Jira Cloud
  (`*.atlassian.net`, account email and API token as Basic auth). Added 2026-09-25, design.md D19.
- Confluence Data Center (PAT) or Confluence Cloud (email and API token). Read only.
- ServiceNow: incidents referenced by number and URL. No API access in v1.
- Microsoft Teams and Outlook are used for communication but are **not**
  integrated in v1. The secretary produces text; the user pastes it.
- LLM access: any OpenAI-compatible chat-completions endpoint and any
  Anthropic-compatible Messages endpoint, user-configured (base URL, key, model).

## 3. Glossary

| Term | Meaning |
|---|---|
| Ticket | A Jira issue of type Epic, Story, Task, Sub-task or Bug |
| Inbox item | A piece of raw input the user gives the secretary (pasted message, typed update) |
| Proposal | A single concrete action the secretary suggests (create issue, comment, link dependency, remember fact, ...) awaiting approval |
| Dependency | Something a ticket waits on that is outside the user's control: a person, a team, a ServiceNow incident, or an external item |
| Contact | A person record with title, team, contact details and communication profile |
| Memory | A stored rule, fact, preference or correction example the secretary uses in later reasoning |
| Brief | The generated summary of what matters now, opened from Today |
| Small ask | A small task that arrives outside planned work. It is a Jira ticket in the small-asks home (a configured project and label), assigned to the user (FR-10) |
| Wait | Another word for an open dependency: someone else has the next move |
| Blocker | A ticket another ticket waits for, recorded in Jira as an "is blocked by" link (FR-3.8) |
| Woke up | A ticket whose blockers are all done, or a wait whose owner is back, shown first on Today with the reason |

## 4. Functional requirements

Each requirement has an ID, a description and acceptance criteria (AC). "Must" is v1
scope; "Should" is v1 if time permits; "Could" is later.

### FR-1 Connect and sync Jira

- FR-1.1 (Must) Configure the Jira base URL and credentials: a Personal Access Token
  on Data Center, or account email and API token on Cloud (design.md D19). Test
  connection shows the current user's display name.
- FR-1.2 (Must) Configure a sync scope: a JQL string (default provided) plus a list of
  tracked Epic keys. Children of tracked epics are always synced.
- FR-1.3 (Must) Incremental sync on demand and on a timer while the app is open
  (default every 10 minutes). Sync stores issue fields listed in `design.md`.
- FR-1.4 (Must) Discover the Epic Link, Epic Name and Sprint custom field IDs
  automatically from `/rest/api/2/field`, with manual override in settings.
- FR-1.5 (Must) Browse tickets as a tree: Epic -> Story/Task -> Sub-task, with filters
  by status category, assignee, project, and free text.
- FR-1.6 (Must) Ticket detail view: fields, description (wiki markup rendered),
  comments, links, attachments list, dependencies, secretary notes.
- FR-1.7 (Must) Manual actions from the detail view: add comment, transition status,
  edit summary/description/priority/assignee/due date, set parent or epic link.
  FR-17 adds story points, the sprint and labels to the edit dialog.
- AC: after configuring against a real Jira instance, all issues matching scope
  appear within one sync; editing a field in the app is visible in Jira within seconds.

### FR-2 Intake: turn messy input into tracker actions

- FR-2.1 (Must) An intake box accepts pasted text (Teams message, email, meeting
  notes) or a typed description. Optional fields: who it came from (contact picker),
  source (Teams/email/meeting/other).
- FR-2.2 (Must) The secretary produces a **triage result**: a one-line summary, and a
  list of typed proposals. Proposal kinds in v1:
  - create issue (epic/story/task/sub-task/bug) with parent or epic link
  - update issue fields
  - add comment to issue
  - transition issue
  - link dependency (person/team/incident/external) to issue
  - link two issues: one is blocked by the other (FR-3.8, D45)
  - update a dependency: log a reply, reschedule or resolve it (FR-3.7, D46)
  - update contact or team profile with a learned fact
  - remember a rule or preference
  - draft a message (hands off to FR-6)
  - "needs clarification" question to the user
- FR-2.3 (Must) Each proposal card shows the target, the concrete payload, the
  rationale, a confidence indicator and edit/approve/reject buttons. Approve-all is
  available. Edits before approval are recorded for learning (FR-7).
- FR-2.4 (Must) Approved proposals execute against Jira and the local DB, in order,
  with per-proposal success/failure shown; failures do not block the rest.
- FR-2.5 (Must) The secretary finds the right existing ticket by: explicit keys in
  the text, full-text match on summaries/descriptions in the cache, recent activity,
  and memories. When unsure it asks rather than guesses.
- FR-2.6 (Should) Inbox history: every intake is kept with its triage and what was
  approved, searchable.
- FR-2.7 (Could) Bulk intake: paste a long chat log and split into several items.
- FR-2.8 (Must) Pasted text stays where it is pasted in the message box, editable in
  place and highlighted as quoted, so a reply like "change the summary to <paste>"
  reads as one sentence. A paste on its own line, or any paste of several lines, is
  input to work on; a one-line paste inside a typed line is a value for that
  instruction. Either way the model treats it as
  someone else's text, never as instructions. The highlight can be removed to make it
  the user's own words (D56).
- AC: given 20 representative inputs from the user, at least 16 produce proposals the
  user accepts without edit or with minor edits; zero writes happen without approval.

### FR-3 Dependencies and follow-ups

- FR-3.1 (Must) A dependency has: kind (person/team/incident/external), owner
  (contact or team), external reference (e.g. INC number) and URL, status
  (open/waiting/blocked/resolved), requested date, expected date, next follow-up
  date, notes and a timeline of follow-ups.
- FR-3.2 (Must) Dependencies can be created from intake proposals or manually from
  a ticket.
- FR-3.3 (Must) A "Waiting on" list shows all open dependencies sorted by overdue
  days, grouped by owner, with a one-click "draft a chase message" (FR-6).
- FR-3.4 (Should) Mirror a dependency as a Jira remote link on the issue (opt-in per
  dependency) so teammates see it in Jira.
- FR-3.5 (Should) OS notifications when a follow-up date arrives while the app runs.
- FR-3.6 (Must, D47) A contact has an optional "away until" date, set by hand or
  proposed from a pasted out-of-office reply. While the owner of a dependency is away
  the dependency sleeps: no reminder, not overdue, not chased. From the first working
  day after the date it is due for follow-up with the reason "<name> is back".
- FR-3.7 (Must, D46) Intake can update an open dependency from pasted text: log a
  reply on its timeline, reschedule it or resolve it. Code supplies the open
  dependencies that may be meant (by sender, by ticket, by wording); the model picks
  from them.
- FR-3.8 (Must, D45) "Do this when ticket X is done" is a Jira "is blocked by" link,
  proposed by intake and created on approval. The app keeps the state of blockers
  fresh, also for blockers outside the sync scope, and when the last open blocker of
  a ticket closes the ticket wakes up: first on Today with the reason, and one OS
  notification.
- AC: a dependency created today with expected date yesterday shows as overdue on the
  dashboard and in the waiting list. Pasting "Bob sent the numbers" from Bob proposes
  resolving the open dependency on Bob. A ticket blocked by PLAT-1 shows as woken up
  after the sync that sees PLAT-1 done.

### FR-4 Organisational context

- FR-4.1 (Must) Teams: name, function, what to contact them for, primary channel,
  escalation path, Confluence links, notes, members.
- FR-4.2 (Must) Contacts: display name, Jira username, email, title, team,
  responsibilities, personality and communication profile (tone, formality, detail
  level, responsiveness, preferred channel, language), free notes.
- FR-4.3 (Must) The user can add or edit all of this directly. The secretary can also
  propose profile updates from intake text (approved like any proposal), and new
  contacts and teams (FR-18).
- FR-4.4 (Must) Confluence: configure the base URL and credentials (a PAT on Data
  Center; account email and API token on Cloud, where the Jira token is reused for the
  same site); search pages with CQL or free text; open a page in the browser;
  **import** a page as a context note attached to a team, contact or ticket (stored
  as Markdown, with source URL and version).
- FR-4.5 (Should) Context notes are included in LLM retrieval for intake, briefs and
  message drafting.
- FR-4.6 (Could) Import/export of teams and contacts as JSON for backup.
- AC: a contact with "prefers short bullet points, formal" produces visibly different
  drafts than one with "casual, likes context".

### FR-5 Dashboard and priorities

Now: the dashboard is the Today page (FR-12, D49). FR-5.1's sections are folded into
its three lists; ranking (FR-5.2), pin and snooze (FR-5.3) and the brief (FR-5.4) are
unchanged.

- FR-5.1 (Must) Dashboard sections: Top focus (ranked tickets), Waiting on me
  (assigned to me, unresolved, recently updated by others, or mentioned), I am
  waiting on (overdue dependencies), At risk (stale or blocked), Due soon, Pending
  inbox proposals, Epic health rollup (per tracked epic: done/in progress/todo
  counts and blocked count).
- FR-5.2 (Must) Ranking is a deterministic, explainable score (Jira priority, due
  proximity, blocked/blocking, staleness, dependency overdue, pin/override). Each
  ranked card can show "why here".
- FR-5.3 (Must) The user can pin, snooze, or override priority on a ticket locally
  without touching Jira.
- FR-5.4 (Should) A generated **daily brief** in prose: what changed since last look,
  what to do first, who to chase. Generated on demand, cached until data changes.
- FR-5.5 (Could) Trend charts (throughput, open dependency count over time).
- AC: dashboard renders in under 1 second from the local cache with 2,000 issues.

### FR-6 Communication drafting

- FR-6.1 (Must) Draft a Teams message or an email (subject + body) given: intent
  (chase, status update, request, escalation, FYI, thank-you), recipient (contact or
  team), related tickets and dependencies, extra notes.
- FR-6.2 (Must) Tone adapts to the recipient's communication profile and team
  function; content is grounded in the linked tickets and dependency history.
- FR-6.3 (Must) Output offers short and standard variants; the user can edit and
  regenerate with instructions; copy to clipboard; mark as "sent" which logs a
  follow-up on the linked dependency.
- FR-6.4 (Should) Output language setting (default English) and a per-contact
  language override.
- FR-6.5 (Should) Recent messages to the same recipient are shown for continuity and
  passed to the model as style context.
- AC: a chase draft for an overdue incident dependency names the incident number,
  the ask, and the date first requested.

### FR-7 Learning and memory

- FR-7.1 (Must) Explicit memory: the user can add rules ("anything about the billing
  migration goes under EPIC-12"), facts and preferences, and view/edit/delete them.
- FR-7.2 (Must) Correction capture: when the user edits or rejects a proposal, the
  before/after pair is stored as a correction example with the input excerpt.
- FR-7.3 (Must) Memories and recent correction examples are retrieved into the
  intake, brief and drafting prompts, within a token budget, ranked by relevance,
  weight and recency.
- FR-7.4 (Should) Consolidation: on request, the secretary reviews correction
  examples and proposes generalised rules; the user approves them into memory.
- FR-7.5 (Should) Provenance on every memory: user-written, or inferred (from which
  inbox item), confirmed or not.
- AC: after correcting the same classification twice, the third similar input is
  classified correctly without edit.

### FR-8 Ask the secretary (chat)

- FR-8.1 (Should) A chat panel that answers questions over local data (tickets,
  dependencies, contacts, notes) and Confluence search using tool calls, and can
  turn its answer into proposals. Writes still go through the proposal flow.

### FR-9 Settings and operations

- FR-9.1 (Must) LLM providers: add multiple named providers (kind: anthropic or
  openai-compatible; base URL; API key; optional extra headers). Test button.
- FR-9.2 (Must) Model tiers: three slots, **fast**, **standard**, **strong**, each
  bound to a provider and model. Unconfigured tiers fall back to the next stronger
  configured tier, so a single model works.
- FR-9.3 (Must) Task routing: every LLM task type has a default tier (table in
  `design.md` section 7.1) that the user can override per task in settings, plus an
  **escalation** toggle: when a task's output fails validation or its confidence is
  below threshold, retry once on the next stronger tier before asking the user.
- FR-9.4 (Should) Evaluation replay: pick a task type and a model, replay stored
  inbox items whose proposals the user approved, and report how often the new
  output matches the approved result. Lets the user judge whether a cheaper model
  is good enough for that task.
- FR-9.5 (Must) Show per-call token usage by tier and a running session total.
- FR-9.6 (Must) Data location shown; export and import of the full local database;
  "reset cache" that clears synced Jira data but keeps secretary data.
- FR-9.7 (Must) Secrets never appear in logs, exports or the UI after entry.

### FR-10 Small asks (D44)

- FR-10.1 (Must) Settings hold the small-asks home: a Jira project, a label (default
  `small-ask`) and whether new small asks join the active sprint (default yes). Saving
  checks the project's create metadata and lists required fields the app cannot fill.
- FR-10.2 (Must) When pasted or typed input holds an ask that no existing ticket
  covers (reply owed, request to send, question to answer, thing to chase or check,
  document to update), intake proposes a ticket in the home. Code sets project, label,
  assignee (the user) and sprint; the model writes the summary and due date and picks
  the issue type and epic from lists the code supplies. An ask that belongs to an
  existing story becomes a sub-task of it.
- FR-10.3 (Must) The proposal shows as one compact row: summary, issue type and epic
  (each changeable from a list), what it waits on, and a Track button that approves
  the ticket and the proposals that hang on it (dependency, blocker link) in one
  click. The full cards are one click away. Nothing is created without that click.
- FR-10.4 (Must) The ticket records who asked: a line and the quoted source in the
  description, and a local link to the contact so "what do I owe Dana" can be answered.
- FR-10.5 (Must) With no home configured, intake behaves as before and the Inbox
  points to the setting once.
- FR-10.6 (Later) Private asks that the team must not see. Not built; the home is an
  ordinary project.
- AC: with a home set, pasting "can you send me the Q3 numbers by Friday?" from a
  contact yields one row; Track creates a ticket in the home project with the label,
  assigned to the user, in the active sprint, due Friday, naming the contact.

### FR-11 Quick capture and tray (D48)

- FR-11.1 (Must) A Capture dialog (the Inbox composer) opens from Ctrl+K, from a
  global shortcut (setting, default Ctrl/Cmd+Shift+Space), from the tray menu and from
  a second launch with `--capture`. Enter files the input and closes the dialog;
  triage runs in the background.
- FR-11.2 (Must) Closing the window keeps the app in the tray (setting, default on)
  so sync, reminders and the shortcut keep working. The tray menu has Open, Capture
  and Quit. A second launch focuses the running app. No extra process.
- FR-11.3 (Must) Where the tray or the shortcut is not available (no appindicator
  library, Wayland), the app says so in settings and works without it.
- FR-11.4 (Should) A notification when a capture made while the window was hidden
  has proposals to approve.

### FR-12 Today and the sweep (D49)

- FR-12.1 (Must) Today replaces the dashboard with a capture box and three lists.
  **Your move**: tickets that woke up, open small asks with nothing to wait for,
  comments and mentions waiting on the user, Inbox threads with pending decisions.
  **Their move**: open dependencies (overdue and due first, sleeping ones last) and
  the user's tickets with an open blocker. **Sprint work**: Top focus (D29) with
  "at risk" and "due soon" as badges.
- FR-12.2 (Must) Row actions without leaving the page: Done (a transition the user
  makes, through the Executor), snooze (tomorrow, Monday, after the sprint, a date),
  chase or reply draft, log a reply, resolve.
- FR-12.3 (Must) A keyboard sweep steps through what needs a decision (woken up,
  follow-ups due, owners back, asks due or overdue, and once a week asks untouched
  for 14 days): done, nudge, snooze, drop, skip.
- FR-12.4 (Must) Epic health moves to the Sprint page; the brief opens from a
  button; suggested prompts stay in the chat.
- AC: Today renders in under 1 second from the local cache with 2,000 issues.

### FR-13 Navigation (D50)

- FR-13.1 (Must) Eight pages: Today, Inbox, Tickets, Waiting on, Sprint (Plan,
  Report, Epics), Drafts, Chat, Context (People, Teams, Memory), plus Settings. Old
  paths redirect.
- FR-13.2 (Must) Drafts also open as a panel from a ticket, a dependency, a person
  and Ctrl+K. (The Drafts page was out of the sidebar at first; it came back on
  2026-10-15 because it was hard to reach.)
- FR-13.3 (Must) Settings group model routing, ranking weights and evaluation
  replay under Advanced.

### FR-14 Revoke an approval (D54)

- FR-14.1 (Must) An executed proposal can be revoked from its card, and a tracked
  small ask from its row (the whole bundle). Revoke opens a confirmation that lists
  each step it will take in Jira and in Secretary; confirming is the approval of
  those steps, and they run through the Executor like any other write.
- FR-14.2 (Must) Each kind is undone the reverse way: a created ticket is deleted
  when the user may delete issues, otherwise moved to a cancelled status (a status
  named like Cancelled, Won't Do, Rejected or Declined, else any done status) with
  a comment; a comment is deleted; field updates, assignee, status, sprint, waits,
  contacts and teams get their previous values back; a blocked-by link Secretary made
  is removed; a wait, a memory or an unsent draft is deleted.
- FR-14.3 (Must) Revoking never overwrites a later change: a field changed by
  someone else since the approval is left as it is and named in a warning.
- FR-14.4 (Must) Revoking a ticket created in a thread first revokes the executed
  proposals of that thread that act on it, newest first.
- FR-14.5 (Must) A step that fails stops the revoke and says what was undone; Revoke
  can be pressed again to finish. A proposal that cannot be undone (a sent draft, a
  sprint that has closed, an approval from before undo data was recorded) says why
  instead of offering Revoke.
- FR-14.6 (Must) Later turns in the same thread know what was revoked: the model
  sees each revoked proposal as approved and then revoked (and whether its ticket was
  deleted or closed), does not treat a deleted ticket as existing, and does not
  propose a revoked action again unless the user asks to redo it. Every other
  thread knows too: a deleted ticket is never synced, offered, named or targeted
  again, and a closed one is offered only when named and then shown as created by
  mistake and revoked by the user. The model does not mention either unless the
  user names it.
- AC: a small ask tracked with a wait and a comment, revoked in the mock Jira as a
  user without delete permission, leaves the ticket in a cancelled status with a
  comment, the Secretary comment deleted, the wait gone and the row marked revoked;
  with delete permission the ticket is gone.

### FR-15 Story points on proposals (D55)

- FR-15.1 (Must) A proposed ticket can carry story points. A number stated in the
  input ("it's a 3-pointer") is used as stated. Otherwise the model suggests one
  from the point values the user's synced tickets use, shown as a suggestion; with
  no point history nothing is suggested.
- FR-15.2 (Must) A small ask without stated points gets the default from Settings >
  Jira > Small asks when one is set (empty by default), instead of a suggestion.
- FR-15.3 (Must) Story points can be edited, or cleared, in the edit dialog and on
  the small-ask row before approving.
- FR-15.4 (Must) Intake can change the story points of an existing ticket when the
  input asks for it or states a new estimate ("PAY-12 is more like a 5"); it never
  re-estimates an existing ticket on its own. Revoking it puts the old value back.
- FR-15.5 (Must) Points are written to the story point field on the ticket's create
  or edit screen. When that screen has none, a create goes ahead without points and
  says so on the card; an update fails with the reason.
- AC: against the mock Jira, a pasted ask that states 3 points creates a ticket with
  3 points; one that states none gets a suggestion from the scale (or the small-ask
  default when set); "PAY-12 is more like a 5" proposes an update that sets 5, and
  revoking it restores the previous value.

### FR-16 New tickets and the sprint (D57)

- FR-16.1 (Must) Every proposed ticket that can join a sprint (not an Epic, not a
  sub-task) offers a choice on its card, its small-ask row and its edit dialog: add
  it to the user's active sprint, or leave it in the backlog. The sprint is named
  with its end and the working days left. The choice starts on for a small ask when
  Settings says so (D44) and for a ticket due on or before the sprint ends, else
  off. Changing it is saved at once and kept by revisions and re-triage. Approve
  stays one click.
- FR-16.2 (Must) Next to the choice the app says whether the sprint has room: the
  user's open work in the sprint, the other new tickets of the same thread that will
  join it, and this ticket, in points and in working days, against the working days
  left: fits, tight or over, with the details one click away. Unestimated tickets
  are counted and named as such; a ticket without points says it cannot be sized.
- FR-16.3 (Must) Settings say what a story point means in working days (for
  example 1 point = 0.5 days). Left empty, the app uses the rate of the user's last
  three closed sprints on that board and says so; with neither, it shows points and
  days without a verdict and links to the setting. Settings also say whether a
  sprint's last day counts.
- FR-16.4 (Should) Today's Sprint work shows the same sprint load in its header,
  and the chat's sprint points answer includes the working days left and the load in
  days.
- AC: with the mock Jira, a sprint with three working days left, two open tickets
  of the user's at 1 point each and 1 point = 0.5 days, a new 2-point ticket shows
  "fits" (2 of 3 days); with a third open ticket of 3 points it shows "over" (3.5 of
  3 days). Its switch on adds it to that sprint on approval; off leaves it in the
  backlog.

### FR-17 Edit an existing ticket (D58)

- FR-17.1 (Must) The ticket view's Edit dialog edits, besides summary, priority,
  due date and description: story points (empty clears them), the sprint (any
  open sprint whose board shows the ticket's project, or the backlog), the epic
  and the labels. Epics have no sprint or epic field; a sub-task has neither and
  says it follows its parent.
- FR-17.2 (Must) Only what changed is written, in one Save. When one write fails
  the dialog stays open and says what was saved and what was not.
- FR-17.3 (Must) Picking the active sprint for a ticket not in it shows the same
  room line and details as a new ticket (FR-16.2), using the points in the dialog.
- FR-17.4 (Must) The Details tab shows the ticket's story points.
- FR-17.5 (Must) The ticket view shows the ticket's Team (Jira's Team field) in
  Details; when a team in Context has the same name, it links there. The Edit
  dialog can change or clear it, picking from the teams on the user's synced
  tickets or a search in Jira (D59).
- AC: against the mock Jira, one Save that sets a backlog ticket's points to 2,
  adds a label and picks the active sprint of the FR-16 AC shows "fits" before
  saving and afterwards shows the ticket in that sprint with 2 points and the
  label; picking Backlog moves it out again.

### FR-18 New contacts and teams from intake and chat (D60)

- FR-18.1 (Must) Intake, and the chat through it, can propose adding a contact
  (name, title, email, Jira user, team, responsibilities, communication profile,
  a note) and a team (name, function, what to contact them for, channel,
  escalation path, a note). They are proposals like any other: shown on a card,
  editable, approved before anything is saved.
- FR-18.2 (Must) A new contact or team is proposed when the user asks for it
  ("add Sarah Lee from Payments as a contact", "create a team Platform"), or when
  another proposal in the same thread needs someone who is not in Context (the
  owner of a wait, the recipient of a draft) and the input names them. Pasted text
  alone never adds people the user did not ask about otherwise.
- FR-18.3 (Must) Other proposals of the same thread can use the new contact or
  team before it exists: a wait owned by it, a draft to it, a new contact in the
  new team, a memory about it. Approving them in order creates it first.
- FR-18.4 (Must) No duplicates: a proposed contact whose name, email or Jira user
  matches an existing one, or a team whose name matches, is refused in code and
  the existing one is used (or updated) instead.
- FR-18.5 (Must) Intake can also move an existing contact to a team, new or
  existing ("Sarah moved to Platform").
- FR-18.6 (Must) Revoking an added contact or team deletes it, after revoking the
  thread's approved proposals that use it; when it was edited since, or something
  outside the thread points at it, the revoke says so and leaves it.
- AC: in the chat, "add Sarah Lee, staff engineer on the Payments team, as a
  contact" with no Payments team in Context proposes a new team and a new contact
  in it; approving both shows them on the Context page with Sarah in Payments.
  "Sarah will send the cert by Friday" pasted after that proposes a wait owned by
  the existing Sarah, not a new contact.

## 5. Non-functional requirements

- NFR-1 Works offline for browsing cached data, drafting from cache and editing
  context. Jira writes queue with a clear "pending" state only if trivial; otherwise
  fail fast with a retry button. v1: fail fast.
- NFR-2 Startup under 2 seconds on a typical laptop; UI stays responsive during sync
  and LLM calls (async, cancellable).
- NFR-3 All outbound HTTP goes only to configured hosts. The `Fetcher` enforces the
  host allow-list in code, because configured hosts are runtime settings that Tauri
  capability scopes cannot list (design.md D27).
- NFR-4 Pasted content is untrusted. Prompts label it as data. Proposals require
  approval, which is the primary defence against prompt injection.
- NFR-5 Unit tests for scoring, retrieval, Jira payload building and proposal
  execution. Contract tests for Jira and Confluence clients against recorded fixtures.
- NFR-6 Accessibility: keyboard navigation for approve/reject and the tree; shadcn
  defaults kept.
- NFR-7 Model robustness. The following never depend on a model: reference
  extraction, candidate retrieval, priority ranking, Jira payload building, output
  validation, sync, dependency and follow-up logic. Every model output is validated
  against a schema and against the candidate set the code supplied (an issue key
  must be one the retrieval step offered or a new-issue placeholder). Switching the
  standard tier from a strong model to a mid-tier model must not change which
  actions are possible, only how often the user needs to edit a proposal.

## 6. Out of scope for v1

- Sending Teams messages or emails automatically; reading mail or chats.
- ServiceNow API integration.
- Multi-user or server deployment.
- Voice input.
- Later, after Phases 11–16: private asks (FR-10.6), turning promises in sent drafts
  into small asks, tasks that watch a Confluence page, dropping a saved email on the
  capture dialog, recurring asks, reading mail and chats through Microsoft Graph.

## 7. Assumptions (settled)

These were open at Phase 0. All are settled; the list stays for the record.

- Jira Data Center 8.14 or newer (PAT support), or Jira Cloud (D19; the user's
  company runs Cloud). The thin REST v2 client (`design.md` D11) serves both.
- Epics: the sync reads both the Epic Link field and `parent`, and writes whichever
  the create or edit metadata accepts. Cloud uses `parent` only.
- Confluence Data Center 7.9 or newer (PAT support), or Confluence Cloud.
- The app acts as the user and can do only what the user's Jira account allows; the
  README lists the permissions each feature needs.
- Default output language English; UI English only.

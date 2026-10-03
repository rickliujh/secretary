/**
 * Chat tools (design.md D25): read-only views of local data, plus
 * `propose_actions`, which hands a request to the intake pipeline.
 */
import { tool } from "ai";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { Effect } from "effect";
import { z } from "zod";
import {
  communications,
  contextNotes,
  inboxItems,
  jiraIssues,
  people,
  proposals,
  teams,
} from "@/db/schema";
import { localDate } from "@/lib/dates";
import { ConfluenceClient } from "@/services/confluence";
import { textToCql, webUrl } from "@/services/confluence/cql";
import { loadToday } from "@/services/dashboard/data";
import { dueWaits } from "@/services/dashboard/today";
import { type Db, query } from "@/services/db";
import { timing } from "@/services/dependencies/logic";
import { listDependencies } from "@/services/dependencies/queries";
import { searchNoteIds } from "@/services/directory/notes";
import { Intake } from "@/services/intake";
import { AttachmentSchema, JiraClient } from "@/services/jira";
import { effectiveFieldIds, storyPointFields } from "@/services/jira/fields";
import { pickSprint, sprintPoints } from "@/services/planning/points";
import { describePayload, type ProposalPayload } from "@/services/proposals/schema";
import { retrievalFtsQuery, tokens } from "@/services/retrieval/ranking";
import { Settings, settingsOrDefault } from "@/services/settings";
import { Sources } from "@/services/sources";
import { getState, parseFieldIds, parseSprintState, SYNC_KEYS } from "@/services/sync/state";
import { searchTicketKeys, ticketDetail } from "@/services/tickets/queries";
import { blockedFacts, pendingDecisions, smallAskFacts, weekAhead } from "./agenda";
import { type AttachmentRef, type ImageForModel, pickImages, prepareImage } from "./images";

export type ToolDeps = Db | Settings | Intake | ConfluenceClient | JiraClient | Sources;
type Exec = <A, E>(effect: Effect.Effect<A, E, ToolDeps>) => Promise<A | { error: string }>;

/** How much of one note the chat reads at once. */
const NOTE_CHARS = 8000;
const noSources = {
  error: "No notes are connected. The user can add an Obsidian vault in Settings > Data sources.",
};

const clip = (s: string | null | undefined, n: number) =>
  !s ? null : s.length > n ? `${s.slice(0, n)}…` : s;

/** Case-insensitive match of every meaningful word of `text` in `haystack`. */
const matches = (haystack: string, text: string) => {
  const words = tokens(text);
  const h = haystack.toLowerCase();
  return words.length > 0 && words.some((w) => h.includes(w));
};

/** The attachments stored with a synced issue. */
const attachmentsOf = (raw: unknown): AttachmentRef[] => {
  const list = (raw as { attachment?: unknown } | null)?.attachment;
  if (!Array.isArray(list)) return [];
  return list.flatMap((a) => {
    const r = AttachmentSchema.safeParse(a);
    return r.success ? [r.data] : [];
  });
};

/**
 * @param showImages receives images a tool fetched, keyed by tool call; the chat
 *   adds them to the next model step (D33).
 */
export function chatTools(
  exec: Exec,
  showImages: (toolCallId: string, key: string, images: ImageForModel[]) => void = () => undefined,
) {
  return {
    search_tickets: tool({
      description: "Find Jira tickets by words in the key, summary, description or comments.",
      inputSchema: z.object({ text: z.string().describe("Words or a ticket key") }),
      execute: ({ text }) =>
        exec(
          Effect.gen(function* () {
            const keys = [...(yield* searchTicketKeys(text))].slice(0, 15);
            if (!keys.length) return { tickets: [] };
            const rows = yield* query((d) =>
              d.select().from(jiraIssues).where(inArray(jiraIssues.key, keys)).all(),
            );
            const order = new Map(keys.map((k, i) => [k, i]));
            return {
              tickets: rows
                .sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0))
                .map((r) => ({
                  key: r.key,
                  summary: r.summary,
                  type: r.issueType,
                  status: r.status,
                  assignee: r.assigneeDisplay,
                  priority: r.priority,
                  storyPoints: r.storyPoints,
                  sprint: r.sprint,
                  due: r.dueDate,
                  epic: r.epicKey,
                  updated: r.updated.slice(0, 10),
                })),
            };
          }),
        ),
    }),

    get_ticket: tool({
      description: "Details of one ticket: fields, description, recent comments and dependencies.",
      inputSchema: z.object({ key: z.string().describe("Issue key, e.g. PAY-12") }),
      execute: ({ key }) =>
        exec(
          Effect.gen(function* () {
            const d = yield* ticketDetail(key.trim().toUpperCase());
            if (!d) return { error: `No ticket ${key} in the local cache.` };
            const i = d.issue;
            const deps = yield* listDependencies({ includeResolved: true, issueKey: i.key });
            return {
              key: i.key,
              summary: i.summary,
              type: i.issueType,
              status: i.status,
              assignee: i.assigneeDisplay,
              reporter: i.reporterDisplay,
              priority: i.priority,
              due: i.dueDate,
              sprint: i.sprint,
              storyPoints: i.storyPoints,
              epic: i.epicKey,
              parent: i.parentKey,
              labels: i.labels,
              updated: i.updated.slice(0, 10),
              description: clip(i.description, 1500),
              attachments: attachmentsOf(i.raw).map((a) => ({
                filename: a.filename,
                type: a.mimeType ?? null,
              })),
              recentComments: d.comments.slice(-5).map((c) => ({
                author: c.authorDisplay,
                at: c.created.slice(0, 10),
                text: clip(c.body, 500),
              })),
              waitingOn: deps.map((x) => ({
                label: x.label,
                owner: x.owner.name,
                status: x.status,
                externalRef: x.externalRef,
                expectedAt: x.expectedAt,
              })),
            };
          }),
        ),
    }),

    view_images: tool({
      description:
        "Look at the pictures attached to a ticket (screenshots in the description or comments). Use it when the question depends on what an image shows. Optionally name the files from get_ticket's attachments.",
      inputSchema: z.object({
        key: z.string().describe("Issue key, e.g. PAY-12"),
        filenames: z.array(z.string()).optional().describe("Only these attachments"),
      }),
      execute: ({ key, filenames }, { toolCallId }) =>
        exec(
          Effect.gen(function* () {
            const d = yield* ticketDetail(key.trim().toUpperCase());
            if (!d) return { error: `No ticket ${key} in the local cache.` };
            const picked = pickImages(
              attachmentsOf(d.issue.raw),
              [d.issue.description ?? "", ...d.comments.map((c) => c.body)],
              filenames ?? [],
            );
            if (!picked.length)
              return { key: d.issue.key, images: [], note: "No image attachments." };
            const jira = yield* JiraClient;
            const shown: ImageForModel[] = [];
            const skipped: string[] = [];
            for (const a of picked) {
              const file = yield* Effect.either(jira.download(a.content ?? ""));
              if (file._tag === "Left") {
                skipped.push(`${a.filename} (${file.left.message})`);
                continue;
              }
              const ready = yield* Effect.promise(() =>
                prepareImage({
                  filename: a.filename,
                  mediaType: a.mimeType ?? file.right.mediaType,
                  data: file.right.bytes,
                }),
              );
              if (ready) shown.push(ready);
              else skipped.push(`${a.filename} (too large)`);
            }
            if (shown.length) showImages(toolCallId, d.issue.key, shown);
            return {
              key: d.issue.key,
              images: shown.map((i) => i.filename),
              skipped,
              note: shown.length
                ? "The images follow in the next message."
                : "None of the images could be loaded.",
            };
          }),
        ),
    }),

    waiting_on: tool({
      description:
        "What the user is waiting on: dependencies with owner, status, expected date, last chase and whether the owner is away; and the user's tickets blocked by another open ticket. Filter by owner (a person or team name) or ticket key.",
      inputSchema: z.object({
        owner: z.string().optional().describe("Person or team name, e.g. Platform"),
        issueKey: z.string().optional(),
        includeResolved: z.boolean().optional(),
      }),
      execute: ({ owner, issueKey, includeResolved }) =>
        exec(
          Effect.gen(function* () {
            const rows = yield* listDependencies({
              includeResolved: includeResolved ?? false,
              issueKey: issueKey?.trim().toUpperCase() || undefined,
            });
            const today = localDate();
            const key = issueKey?.trim().toUpperCase() || undefined;
            // Tickets blocked by other tickets have no owner, so an owner filter leaves
            // them out. All of them, also those Today lists in Your move for a new comment.
            const blocked = owner
              ? []
              : (yield* loadToday()).blocked.filter((r) => !key || r.issue.key === key);
            return {
              blockedTickets: blockedFacts(blocked),
              waiting: rows
                .filter((r) => !owner || matches(r.owner.name, owner))
                .map((r) => ({ r, t: timing(r, today) }))
                .map(({ r, t }) => ({
                  issueKey: r.issueKey,
                  issueSummary: r.issueSummary,
                  label: r.label,
                  kind: r.kind,
                  externalRef: r.externalRef,
                  owner: `${r.owner.name}${r.owner.type === "team" ? " (team)" : ""}`,
                  status: r.status,
                  requestedAt: r.requestedAt?.slice(0, 10) ?? null,
                  expectedAt: r.expectedAt,
                  lastChased: r.lastFollowupAt?.slice(0, 10) ?? null,
                  nextChase: t.followupOn,
                  overdueDays: t.overdueDays,
                  followUpDue: t.followupDue,
                  // The owner is away (D47): do not chase before they are back.
                  ownerAwayUntil: t.awayUntil,
                  note: t.reason,
                })),
            };
          }),
        ),
    }),

    find_contacts: tool({
      description:
        "Find people and teams by name, role, responsibility or what a team is the contact for.",
      inputSchema: z.object({ text: z.string() }),
      execute: ({ text }) =>
        exec(
          Effect.gen(function* () {
            const ps = yield* query((d) => d.select().from(people).all());
            const ts = yield* query((d) => d.select().from(teams).all());
            const teamName = new Map(ts.map((t) => [t.id, t.name]));
            return {
              people: ps
                .filter((p) =>
                  matches(
                    [p.displayName, p.title, p.responsibilities, teamName.get(p.teamId ?? "")].join(
                      " ",
                    ),
                    text,
                  ),
                )
                .slice(0, 10)
                .map((p) => ({
                  name: p.displayName,
                  title: p.title,
                  team: teamName.get(p.teamId ?? "") ?? null,
                  email: p.email,
                  jira: p.jiraUsername,
                  responsibilities: clip(p.responsibilities, 300),
                  prefers: p.profile,
                })),
              teams: ts
                .filter((t) => matches([t.name, t.function, t.contactFor].join(" "), text))
                .slice(0, 10)
                .map((t) => ({
                  name: t.name,
                  function: t.function,
                  contactFor: t.contactFor,
                  channel: t.channel,
                  escalationPath: t.escalationPath,
                })),
            };
          }),
        ),
    }),

    search_notes: tool({
      description:
        "Search the user's notes about people, teams and tickets, including imported Confluence pages.",
      inputSchema: z.object({ text: z.string() }),
      execute: ({ text }) =>
        exec(
          Effect.gen(function* () {
            const match = retrievalFtsQuery(text);
            if (!match) return { notes: [] };
            const ids = (yield* searchNoteIds(match)).map((r) => r.id).slice(0, 8);
            if (!ids.length) return { notes: [] };
            const rows = yield* query((d) =>
              d.select().from(contextNotes).where(inArray(contextNotes.id, ids)).all(),
            );
            return {
              notes: rows.map((n) => ({
                about: `${n.subjectType} ${n.subjectId}`,
                title: n.title,
                text: clip(n.bodyMd, 800),
                source: n.sourceUrl,
              })),
            };
          }),
        ),
    }),

    my_focus: tool({
      description:
        "What the user should focus on: their work in the active sprint (plus pinned tickets), ranked with reasons; also what is due soon, what others wait on them for, and what is at risk.",
      inputSchema: z.object({}),
      execute: () =>
        exec(
          Effect.map(loadToday(), ({ facts: d, focus }) => ({
            focusCovers:
              focus.mode === "sprint"
                ? `the active sprint ${focus.sprints.join(", ")}${focus.endsOn ? `, ending ${focus.endsOn}` : ""}, plus pinned tickets`
                : "all open work in scope (no active sprint)",
            topFocus: d.topFocus.slice(0, 10).map((f) => ({
              key: f.key,
              summary: f.summary,
              status: f.status,
              due: f.dueDate,
              why: f.contributions.map((c) => c.reason),
            })),
            dueSoon: d.dueSoon
              .slice(0, 10)
              .map((i) => ({ key: i.key, summary: i.summary, daysLeft: i.daysLeft })),
            waitingOnMe: d.waitingOnMe
              .slice(0, 10)
              .map((f) => ({ key: f.issue.key, summary: f.issue.summary, why: f.reasons })),
            atRisk: d.atRisk
              .slice(0, 10)
              .map((f) => ({ key: f.issue.key, summary: f.issue.summary, why: f.reasons })),
          })),
        ),
    }),

    sprint_points: tool({
      description:
        "Story points in a sprint, added up in code: total, done, remaining, and which tickets have no estimate. Defaults to the user's active sprint and the user's own tickets. Use it for any question about points, capacity or how much work is in a sprint.",
      inputSchema: z.object({
        sprint: z
          .string()
          .describe("Sprint name or part of it; empty for the active sprint")
          .default(""),
        who: z
          .enum(["me", "everyone"])
          .describe("The user's tickets only, or everyone's in the sprint")
          .default("me"),
      }),
      execute: ({ sprint, who }) =>
        exec(
          Effect.gen(function* () {
            const settings = yield* settingsOrDefault(yield* Settings);
            const fields = effectiveFieldIds(
              parseFieldIds(yield* getState(SYNC_KEYS.fields)),
              settings.jira.fields,
            );
            if (!storyPointFields(fields).length)
              return {
                error:
                  "No story point field is known for this Jira. The user can set it in Settings > Jira > Fields; until then points cannot be counted.",
              };
            const me = (yield* getState(SYNC_KEYS.username)) ?? null;
            const sprints = parseSprintState(yield* getState(SYNC_KEYS.sprints)).sprints;
            const issues = yield* query((d) =>
              d
                .select({
                  key: jiraIssues.key,
                  summary: jiraIssues.summary,
                  issueType: jiraIssues.issueType,
                  isSubtask: jiraIssues.isSubtask,
                  status: jiraIssues.status,
                  statusCategory: jiraIssues.statusCategory,
                  assignee: jiraIssues.assignee,
                  assigneeDisplay: jiraIssues.assigneeDisplay,
                  sprint: jiraIssues.sprint,
                  storyPoints: jiraIssues.storyPoints,
                })
                .from(jiraIssues)
                .where(and(eq(jiraIssues.stale, false), isNotNull(jiraIssues.sprint)))
                .all(),
            );
            const picked = pickSprint(sprints, issues, me, sprint);
            if (!picked)
              return {
                error: sprint
                  ? `No sprint matches "${sprint}".`
                  : "There is no active sprint in the synced data.",
                knownSprints: sprints
                  .filter((s) => s.state !== "closed")
                  .map((s) => `${s.name} (${s.state})`)
                  .slice(0, 20),
              };
            if (who === "me" && !me)
              return { error: "The Jira user is not known yet; run a sync." };
            const r = sprintPoints(issues, picked.name, who === "me" ? me : null);
            return {
              sprint: {
                name: picked.name,
                state: picked.state,
                start: picked.start,
                end: picked.end,
              },
              who,
              ...r,
              tickets: r.tickets.slice(0, 40),
              note:
                r.tickets.length > 0 && r.estimated === 0
                  ? "None of these tickets has an estimate in Jira."
                  : undefined,
            };
          }),
        ),
    }),

    search_vault: tool({
      description:
        "Search the user's own notes (their Obsidian vaults): projects, meeting notes, decisions, how-tos, people and anything they wrote down. Returns the best matching notes with their matching lines. Use read_vault_note to read one.",
      inputSchema: z.object({
        query: z.string().describe("Words to look for; names, project terms, topics"),
      }),
      execute: ({ query: text }) =>
        exec(
          Effect.gen(function* () {
            const settings = yield* settingsOrDefault(yield* Settings);
            if (!settings.dataSources.some((s) => s.enabled)) return noSources;
            const hits = yield* (yield* Sources).search(text, { limit: 8 });
            return {
              notes: hits.map((h) => ({
                vault: h.sourceName,
                sourceId: h.sourceId,
                path: h.path,
                title: h.title,
                matchingLines: h.matches,
                excerpt: h.snippet,
              })),
            };
          }),
        ),
    }),

    read_vault_note: tool({
      description:
        "Read one of the user's notes from search_vault, by its path (or its name, or a [[link]] target), with its properties, tags and the notes linking to it.",
      inputSchema: z.object({
        sourceId: z.string().describe("sourceId from search_vault"),
        path: z.string().describe("path from search_vault, or the note's file name (not an alias)"),
      }),
      execute: ({ sourceId, path }) =>
        exec(
          Effect.gen(function* () {
            const n = yield* (yield* Sources).read(sourceId, path);
            return {
              vault: n.sourceName,
              path: n.path,
              title: n.title,
              properties: n.properties,
              tags: n.tags,
              text: clip(n.body, NOTE_CHARS),
              truncated: n.body.length > NOTE_CHARS,
              linkedFrom: n.backlinks.slice(0, 30),
            };
          }),
        ),
    }),

    pending_decisions: tool({
      description:
        "What waits on a decision from the user: proposals to approve and questions to answer in the Inbox (by thread, with how long they have waited), the user's open small asks (who asked, how long ago, when due and where each stands), people waiting on the user, follow-ups due, and drafts not sent yet.",
      inputSchema: z.object({}),
      execute: () =>
        exec(
          Effect.gen(function* () {
            const today = localDate();
            const rows = yield* query((d) =>
              d
                .select({
                  inboxItemId: proposals.inboxItemId,
                  kind: proposals.kind,
                  payload: proposals.payload,
                  editedPayload: proposals.editedPayload,
                  createdAt: proposals.createdAt,
                  threadSummary: inboxItems.summary,
                  receivedAt: inboxItems.receivedAt,
                })
                .from(proposals)
                .innerJoin(inboxItems, eq(inboxItems.id, proposals.inboxItemId))
                .where(eq(proposals.status, "pending"))
                .all(),
            );
            const drafts = yield* query((d) =>
              d
                .select({
                  issueKeys: communications.issueKeys,
                  createdAt: communications.createdAt,
                  person: people.displayName,
                  team: teams.name,
                })
                .from(communications)
                .leftJoin(people, eq(people.id, communications.recipientPersonId))
                .leftJoin(teams, eq(teams.id, communications.recipientTeamId))
                .where(eq(communications.status, "draft"))
                .all(),
            );
            const decisions = pendingDecisions(
              rows.map((r) => {
                const payload = (r.editedPayload ?? r.payload) as ProposalPayload;
                return {
                  inboxItemId: r.inboxItemId ?? "",
                  threadSummary: r.threadSummary,
                  receivedAt: r.receivedAt,
                  kind: r.kind,
                  description: describePayload(payload),
                  question: payload.kind === "needs_clarification" ? payload.question : null,
                  createdAt: r.createdAt,
                };
              }),
              drafts.map((d) => ({
                to: d.person ?? d.team ?? "someone",
                issueKeys: d.issueKeys,
                updatedAt: d.createdAt,
              })),
              today,
            );
            const t = yield* loadToday();
            return {
              ...decisions,
              smallAsks: smallAskFacts(t.smallAsks.open, today),
              waitingOnMe: t.facts.waitingOnMe.map((w) => ({
                key: w.issue.key,
                summary: w.issue.summary,
                why: w.reasons,
              })),
              // Sleeping waits (owner away, ticket snoozed) are left out, as in the brief.
              followupsDue: dueWaits(t).map(({ dependency: d, timing: w }) => ({
                issueKey: d.issueKey,
                label: d.label,
                owner: d.ownerName,
                ...(w.reason ? { why: w.reason } : {}),
              })),
            };
          }),
        ),
    }),

    week_ahead: tool({
      description:
        "The next seven days, day by day: tickets due, answers expected from people and teams, follow-ups to make, and the sprint's end with points done; plus what is at risk.",
      inputSchema: z.object({}),
      execute: () =>
        exec(
          Effect.gen(function* () {
            const today = localDate();
            const { facts: dash } = yield* loadToday();
            const deps = yield* listDependencies({});
            const me = (yield* getState(SYNC_KEYS.username)) ?? null;
            const sprints = parseSprintState(yield* getState(SYNC_KEYS.sprints)).sprints;
            const issues = yield* query((d) =>
              d
                .select({
                  key: jiraIssues.key,
                  summary: jiraIssues.summary,
                  issueType: jiraIssues.issueType,
                  isSubtask: jiraIssues.isSubtask,
                  status: jiraIssues.status,
                  statusCategory: jiraIssues.statusCategory,
                  assignee: jiraIssues.assignee,
                  assigneeDisplay: jiraIssues.assigneeDisplay,
                  sprint: jiraIssues.sprint,
                  storyPoints: jiraIssues.storyPoints,
                })
                .from(jiraIssues)
                .where(and(eq(jiraIssues.stale, false), isNotNull(jiraIssues.sprint)))
                .all(),
            );
            const active = pickSprint(sprints, issues, me);
            const points = active && me ? sprintPoints(issues, active.name, me) : null;
            return weekAhead({
              today,
              dueSoon: dash.dueSoon.map((i) => ({
                key: i.key,
                summary: i.summary,
                dueDate: i.dueDate,
                status: i.status,
              })),
              dependencies: deps
                .filter((d) => d.status !== "resolved")
                .map((d) => ({
                  issueKey: d.issueKey,
                  label: d.label,
                  owner: d.owner.name,
                  expectedAt: d.expectedAt,
                  // A sleeping wait is chased the day its owner is back (D47).
                  nextFollowupAt: timing(d, today).followupOn,
                })),
              sprint:
                active && active.state === "active"
                  ? {
                      name: active.name,
                      end: active.end,
                      total: points?.total ?? 0,
                      done: points?.done ?? 0,
                    }
                  : null,
              atRisk: dash.atRisk.map((r) => ({
                key: r.issue.key,
                summary: r.issue.summary,
                why: r.reasons,
              })),
            });
          }),
        ),
    }),

    search_confluence: tool({
      description: "Search Confluence pages by words.",
      inputSchema: z.object({ text: z.string() }),
      execute: ({ text }) =>
        exec(
          Effect.gen(function* () {
            const cql = textToCql(text);
            if (!cql) return { pages: [] };
            const settings = yield* (yield* Settings).get;
            const r = yield* (yield* ConfluenceClient).search(cql, { limit: 8 });
            const base = r._links.base ?? settings.confluence.baseUrl ?? "";
            return {
              pages: r.results.map((p) => ({
                title: p.title,
                space: p.space?.name ?? p.space?.key ?? null,
                url: webUrl(p._links, base),
              })),
            };
          }),
        ),
    }),

    propose_actions: tool({
      description:
        "Ask for changes (comment, update fields, move status, create a ticket, track a dependency, draft a message, remember something). The request goes through the Inbox, where the user reviews and approves each proposal.",
      inputSchema: z.object({
        request: z
          .string()
          .describe("The change in the user's words, with the ticket keys it concerns"),
      }),
      execute: ({ request }) =>
        exec(
          Effect.gen(function* () {
            const r = yield* (yield* Intake).triage({
              text: request,
              source: "typed",
              senderPersonId: null,
            });
            const rows = yield* query((d) =>
              d.select().from(proposals).where(eq(proposals.inboxItemId, r.inboxItemId)).all(),
            );
            return {
              threadId: r.inboxItemId,
              proposed: rows
                .filter((p) => p.kind !== "needs_clarification")
                .map((p) => describePayload(p.payload as ProposalPayload)),
              questions: rows
                .filter((p) => p.kind === "needs_clarification")
                .map((p) => describePayload(p.payload as ProposalPayload)),
              note: "Nothing has changed yet. The user approves these in the Inbox.",
            };
          }),
        ),
    }),
  };
}

export type ChatTools = ReturnType<typeof chatTools>;

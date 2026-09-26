/**
 * Chat tools (design.md D25): read-only views of local data, plus
 * `propose_actions`, which hands a request to the intake pipeline.
 */
import { tool } from "ai";
import { eq, inArray } from "drizzle-orm";
import { Effect } from "effect";
import { z } from "zod";
import { contextNotes, jiraIssues, people, proposals, teams } from "@/db/schema";
import { ConfluenceClient } from "@/services/confluence";
import { textToCql, webUrl } from "@/services/confluence/cql";
import { dashboardWithBrief } from "@/services/dashboard/brief";
import { type Db, query } from "@/services/db";
import { listDependencies } from "@/services/dependencies/queries";
import { searchNoteIds } from "@/services/directory/notes";
import { Intake } from "@/services/intake";
import { AttachmentSchema, JiraClient } from "@/services/jira";
import { describePayload, type ProposalPayload } from "@/services/proposals/schema";
import { retrievalFtsQuery, tokens } from "@/services/retrieval/ranking";
import { Settings } from "@/services/settings";
import { searchTicketKeys, ticketDetail } from "@/services/tickets/queries";
import { type AttachmentRef, type ImageForModel, pickImages, prepareImage } from "./images";

export type ToolDeps = Db | Settings | Intake | ConfluenceClient | JiraClient;
type Exec = <A, E>(effect: Effect.Effect<A, E, ToolDeps>) => Promise<A | { error: string }>;

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
        "What the user is waiting on: dependencies with owner, status, expected date and last chase. Filter by owner (a person or team name) or ticket key.",
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
            return {
              waiting: rows
                .filter((r) => !owner || matches(r.owner.name, owner))
                .map((r) => ({
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
                  nextChase: r.nextFollowupAt,
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
          Effect.map(dashboardWithBrief(), ({ dashboard: d }) => ({
            focusCovers:
              d.focus.mode === "sprint"
                ? `the active sprint ${d.focus.sprints.join(", ")}${d.focus.endsOn ? `, ending ${d.focus.endsOn}` : ""}, plus pinned tickets`
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

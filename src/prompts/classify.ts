/**
 * `classify_item`: one item -> candidate-constrained proposals (design.md 7.3
 * step 4). The output schema is built per item from the retrieved candidates,
 * so enums carry the allowed keys and ids; `validateItemOutput` checks what
 * enums cannot. All fields are nullable rather than optional so the schema
 * works with strict structured-output modes across providers.
 */
import { z } from "zod";
import { CHANNELS, DETAIL, FORMALITY, RESPONSIVENESS } from "@/services/directory/schema";
import {
  DEPENDENCY_KINDS,
  MEMORY_KINDS,
  MESSAGE_INTENTS,
  NEW_REF_RE,
  type ProposalPayload,
  ProposalPayloadSchema,
} from "@/services/proposals/schema";
import { HARD_RULES, untrusted } from "./common";

export const CLASSIFY_PROMPT_VERSION = 1;
export const NEW_REFS = ["$new:1", "$new:2", "$new:3", "$new:4", "$new:5"] as const;

export type CandidateIssue = {
  key: string;
  summary: string;
  issueType: string;
  status: string;
  statusCategory: string;
  projectKey: string;
  epicKey: string | null;
  parentKey: string | null;
  assignee: string | null;
  updated: string;
  /** Why retrieval picked it: "mentioned", "search", "recent", "sender". */
  reasons: string[];
};

/** Everything the model sees for one item, stored on the item for replay. */
export type ItemSnapshot = {
  promptVersion: number;
  today: string;
  me: { username: string } | null;
  outputLanguage: string;
  source: string;
  sender: { id: string; displayName: string; title: string | null; team: string | null } | null;
  quote: string;
  references: { issueKeys: string[]; tickets: string[]; urls: string[]; contactIds: string[] };
  candidates: CandidateIssue[];
  projects: { key: string; issueTypes: string[]; statuses: string[] }[];
  priorities: string[];
  jiraUsers: { username: string; displayName: string }[];
  teams: { id: string; name: string; function: string | null; contactFor: string | null }[];
  people: {
    id: string;
    displayName: string;
    title: string | null;
    team: string | null;
    jiraUsername: string | null;
  }[];
  dependencies: { issueKey: string; label: string; status: string }[];
  memories: { kind: string; content: string }[];
  examples: { input: string; proposed: string; corrected: string | null }[];
  notes: { about: string; title: string; excerpt: string }[];
};

const enumOf = (values: readonly string[]) => z.enum(values as [string, ...string[]]);
const nullableEnum = (values: readonly string[]) =>
  values.length > 0 ? enumOf(values).nullable() : z.null();

const common = {
  rationale: z.string().describe("One sentence: why this action, citing the input"),
  evidence: z.string().describe("The exact words from the input that support this action"),
  confidence: z.number().describe("0 to 1: how sure you are this action is right"),
};

/** Builds the per-item output schema from the snapshot's candidates. */
export function buildItemSchema(s: ItemSnapshot) {
  const targets = enumOf([...s.candidates.map((c) => c.key), ...NEW_REFS]);
  const projects = s.projects.map((p) => p.key);
  const issueTypes = [...new Set(s.projects.flatMap((p) => p.issueTypes))];
  const epics = s.candidates.filter((c) => c.issueType === "Epic").map((c) => c.key);
  const statuses = [...new Set(s.projects.flatMap((p) => p.statuses))];
  const users = s.jiraUsers.map((u) => u.username);
  const personIds = s.people.map((p) => p.id);
  const teamIds = s.teams.map((t) => t.id);

  const variants: z.ZodObject[] = [
    z.object({
      kind: z.literal("add_comment"),
      target: targets,
      body: z.string().describe("Comment text in Markdown"),
      ...common,
    }),
    z.object({
      kind: z.literal("update_issue"),
      target: targets,
      summary: z.string().nullable(),
      priority: nullableEnum(s.priorities),
      dueDate: z.string().nullable().describe("YYYY-MM-DD"),
      assignee: nullableEnum(users).describe("Jira username"),
      ...common,
    }),
    z.object({
      kind: z.literal("transition_issue"),
      target: targets,
      toStatus: statuses.length > 0 ? enumOf(statuses) : z.string(),
      ...common,
    }),
    z.object({
      kind: z.literal("link_dependency"),
      target: targets,
      dependencyKind: z.enum(DEPENDENCY_KINDS),
      label: z.string().describe("What or who the issue is waiting on"),
      ownerPersonId: nullableEnum(personIds),
      ownerTeamId: nullableEnum(teamIds),
      externalRef: z.string().nullable().describe("For incidents: the ServiceNow number"),
      expectedAt: z.string().nullable().describe("YYYY-MM-DD"),
      ...common,
    }),
    z.object({
      kind: z.literal("remember"),
      memoryKind: z.enum(MEMORY_KINDS),
      content: z
        .string()
        .describe("The rule, fact or preference, stated so it makes sense on its own"),
      ...common,
    }),
    z.object({
      kind: z.literal("draft_message"),
      channel: z.enum(["teams", "email"]),
      intent: z.enum(MESSAGE_INTENTS),
      recipientPersonId: nullableEnum(personIds),
      recipientTeamId: nullableEnum(teamIds),
      issueKeys: z.array(targets),
      notes: z.string().describe("What the message should say"),
      ...common,
    }),
  ];
  if (projects.length > 0) {
    variants.unshift(
      z.object({
        kind: z.literal("create_issue"),
        ref: z.enum(NEW_REFS),
        projectKey: enumOf(projects),
        issueType: issueTypes.length > 0 ? enumOf(issueTypes) : z.string(),
        summary: z.string(),
        description: z.string().nullable().describe("Markdown"),
        parent: z
          .union([
            nullableEnum(s.candidates.filter((c) => c.issueType !== "Epic").map((c) => c.key)),
            z.enum(NEW_REFS),
          ])
          .nullable()
          .describe("Only for Sub-task"),
        epic: z.union([nullableEnum(epics), z.enum(NEW_REFS)]).nullable(),
        priority: nullableEnum(s.priorities),
        assignee: nullableEnum(users),
        dueDate: z.string().nullable().describe("YYYY-MM-DD"),
        ...common,
      }),
    );
  }
  if (personIds.length > 0) {
    variants.push(
      z.object({
        kind: z.literal("update_person"),
        personId: enumOf(personIds),
        title: z.string().nullable(),
        responsibilities: z.string().nullable(),
        formality: z.enum(FORMALITY).nullable(),
        detail: z.enum(DETAIL).nullable(),
        responsiveness: z.enum(RESPONSIVENESS).nullable(),
        preferredChannel: z.enum(CHANNELS).nullable(),
        tone: z.string().nullable(),
        note: z.string().nullable().describe("A fact about the person worth keeping"),
        ...common,
      }),
    );
  }
  if (teamIds.length > 0) {
    variants.push(
      z.object({
        kind: z.literal("update_team"),
        teamId: enumOf(teamIds),
        function: z.string().nullable(),
        contactFor: z.string().nullable(),
        channel: z.string().nullable(),
        escalationPath: z.string().nullable(),
        note: z.string().nullable(),
        ...common,
      }),
    );
  }

  return z.object({
    summary: z.string().describe("One line: what this item is about and what should happen"),
    proposals: z.array(z.discriminatedUnion("kind", variants as [z.ZodObject, ...z.ZodObject[]])),
    question: z.string().nullable().describe("Ask the user when you are unsure; otherwise null"),
    confidence: z.number().describe("0 to 1: overall confidence in these proposals"),
  });
}

export type ItemOutput = {
  summary: string;
  question: string | null;
  confidence: number;
  proposals: ({ kind: string; rationale: string; evidence: string; confidence: number } & Record<
    string,
    unknown
  >)[];
};

export type MappedProposal = {
  payload: ProposalPayload;
  rationale: string;
  evidence: string;
  confidence: number;
};

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const defined = <T extends Record<string, unknown>>(o: T) =>
  Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== null && v !== undefined),
  ) as Partial<T>;

/** Maps one model proposal to a canonical payload (throws on shapes the schema should have prevented). */
export function toPayload(p: ItemOutput["proposals"][number]): ProposalPayload {
  const g = (k: string) => p[k];
  switch (p.kind) {
    case "create_issue":
      return ProposalPayloadSchema.parse({
        kind: "create_issue",
        ref: g("ref"),
        projectKey: g("projectKey"),
        issueType: g("issueType"),
        summary: g("summary"),
        descriptionMd: str(g("description")),
        parent: str(g("parent")),
        epic: str(g("epic")),
        priority: str(g("priority")),
        assignee: str(g("assignee")),
        dueDate: str(g("dueDate")),
      });
    case "update_issue":
      return ProposalPayloadSchema.parse({
        kind: "update_issue",
        target: g("target"),
        changes: defined({
          summary: str(g("summary")),
          priority: str(g("priority")),
          dueDate: str(g("dueDate")),
          assignee: str(g("assignee")),
        }),
      });
    case "add_comment":
      return ProposalPayloadSchema.parse({
        kind: "add_comment",
        target: g("target"),
        bodyMd: g("body"),
      });
    case "transition_issue":
      return ProposalPayloadSchema.parse({
        kind: "transition_issue",
        target: g("target"),
        toStatus: g("toStatus"),
      });
    case "link_dependency":
      return ProposalPayloadSchema.parse({
        kind: "link_dependency",
        target: g("target"),
        dependencyKind: g("dependencyKind"),
        label: g("label"),
        ownerPersonId: str(g("ownerPersonId")),
        ownerTeamId: str(g("ownerTeamId")),
        externalRef: str(g("externalRef")),
        expectedAt: str(g("expectedAt")),
      });
    case "update_person":
      return ProposalPayloadSchema.parse({
        kind: "update_person",
        personId: g("personId"),
        changes: defined({
          title: str(g("title")),
          responsibilities: str(g("responsibilities")),
          profile: (() => {
            const profile = defined({
              formality: str(g("formality")),
              detail: str(g("detail")),
              responsiveness: str(g("responsiveness")),
              preferredChannel: str(g("preferredChannel")),
              tone: str(g("tone")),
            });
            return Object.keys(profile).length ? profile : null;
          })(),
        }),
        noteAppend: str(g("note")),
      });
    case "update_team":
      return ProposalPayloadSchema.parse({
        kind: "update_team",
        teamId: g("teamId"),
        changes: defined({
          function: str(g("function")),
          contactFor: str(g("contactFor")),
          channel: str(g("channel")),
          escalationPath: str(g("escalationPath")),
        }),
        noteAppend: str(g("note")),
      });
    case "remember":
      return ProposalPayloadSchema.parse({
        kind: "remember",
        memoryKind: g("memoryKind"),
        content: g("content"),
      });
    case "draft_message":
      return ProposalPayloadSchema.parse({
        kind: "draft_message",
        channel: g("channel"),
        intent: g("intent"),
        recipientPersonId: str(g("recipientPersonId")),
        recipientTeamId: str(g("recipientTeamId")),
        issueKeys: g("issueKeys") ?? [],
        notes: g("notes") ?? "",
      });
    default:
      throw new Error(`Unknown proposal kind "${p.kind}"`);
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (v: unknown) =>
  v === null ||
  v === undefined ||
  (typeof v === "string" && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v)));

/**
 * Business-rule checks the schema cannot express (design.md 7.0 rule 4).
 * Returns error strings for the repair prompt; empty means valid.
 */
export function validateItemOutput(out: ItemOutput, s: ItemSnapshot): string[] {
  const errors: string[] = [];
  const candidates = new Map(s.candidates.map((c) => [c.key, c]));
  const created = new Map<string, ItemOutput["proposals"][number]>();
  for (const p of out.proposals)
    if (p.kind === "create_issue" && typeof p.ref === "string") {
      if (created.has(p.ref))
        errors.push(`${p.ref} is created twice; use a different ref for each new issue.`);
      created.set(p.ref, p);
    }
  const project = (key: string) => s.projects.find((p) => p.key === key);
  const knownUsers = new Set(s.jiraUsers.map((u) => u.username));
  const isEpic = (ref: string) =>
    candidates.get(ref)?.issueType === "Epic" || created.get(ref)?.issueType === "Epic";

  out.proposals.forEach((p, i) => {
    const at = `Proposal ${i + 1} (${p.kind})`;
    for (const field of ["target", "parent", "epic"]) {
      const v = p[field];
      if (typeof v === "string" && NEW_REF_RE.test(v) && !created.has(v))
        errors.push(`${at}: ${field} ${v} is not created by any create_issue in this answer.`);
      if (typeof v === "string" && !NEW_REF_RE.test(v) && !candidates.has(v))
        errors.push(`${at}: ${field} ${v} is not one of the candidate issues.`);
    }
    for (const field of ["dueDate", "expectedAt"]) {
      if (!validDate(p[field])) errors.push(`${at}: ${field} must be YYYY-MM-DD or null.`);
    }
    if (typeof p.assignee === "string" && !knownUsers.has(p.assignee))
      errors.push(`${at}: assignee ${p.assignee} is not a known Jira username.`);
    if (!p.evidence?.trim()) errors.push(`${at}: evidence must quote the input.`);

    if (p.kind === "create_issue") {
      const proj = project(String(p.projectKey));
      if (proj && proj.issueTypes.length > 0 && !proj.issueTypes.includes(String(p.issueType)))
        errors.push(
          `${at}: issue type ${p.issueType} is not available in ${p.projectKey} (${proj.issueTypes.join(", ")}).`,
        );
      const subtask = /sub-?task/i.test(String(p.issueType));
      if (subtask && !p.parent) errors.push(`${at}: a Sub-task needs a parent.`);
      if (!subtask && p.parent)
        errors.push(`${at}: only a Sub-task has a parent; use epic for epics.`);
      if (typeof p.epic === "string" && !isEpic(p.epic))
        errors.push(`${at}: epic ${p.epic} is not an Epic.`);
      if (p.issueType === "Epic" && p.epic) errors.push(`${at}: an Epic cannot belong to an epic.`);
      if (!str(p.summary)) errors.push(`${at}: summary is empty.`);
    }
    if (p.kind === "transition_issue") {
      const c = candidates.get(String(p.target));
      const proj = c ? project(c.projectKey) : undefined;
      if (proj && proj.statuses.length > 0 && !proj.statuses.includes(String(p.toStatus)))
        errors.push(
          `${at}: status ${p.toStatus} is not used in ${proj.key} (${proj.statuses.join(", ")}).`,
        );
      if (c && c.status === p.toStatus) errors.push(`${at}: ${c.key} is already ${c.status}.`);
    }
    if (
      p.kind === "link_dependency" &&
      p.dependencyKind === "incident" &&
      !/^[A-Z]{2,6}\d{7,}$/.test(String(p.externalRef ?? ""))
    )
      errors.push(`${at}: an incident dependency needs externalRef like INC0012345.`);
    if (
      p.kind === "update_issue" &&
      ["summary", "priority", "dueDate", "assignee"].every(
        (k) => p[k] === null || p[k] === undefined,
      )
    )
      errors.push(`${at}: update_issue must change at least one field.`);
    if (p.kind === "draft_message" && !p.recipientPersonId && !p.recipientTeamId)
      errors.push(`${at}: draft_message needs a recipient person or team.`);
    if (p.kind === "add_comment" && !str(p.body)) errors.push(`${at}: comment body is empty.`);
    // A structurally valid proposal must also map cleanly to a payload.
    try {
      toPayload(p);
    } catch (e) {
      errors.push(
        `${at}: ${e instanceof z.ZodError ? e.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ") : String(e)}`,
      );
    }
  });
  if (out.proposals.length === 0 && !out.question?.trim())
    errors.push("Return at least one proposal, or a question if you are unsure.");
  return errors;
}

export function mapItemOutput(out: ItemOutput): MappedProposal[] {
  return out.proposals.map((p) => ({
    payload: toPayload(p),
    rationale: p.rationale,
    evidence: p.evidence,
    confidence: clamp01(p.confidence),
  }));
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const line = (parts: (string | null | undefined | false)[]) => parts.filter(Boolean).join(" | ");

export function buildClassifyPrompt(s: ItemSnapshot) {
  const system = `You are a personal work secretary. You turn one piece of incoming text into concrete, approvable actions on the user's Jira Data Center tickets and their notes about people and teams.
${HARD_RULES}
- Today is ${s.today}. Resolve relative dates ("Friday", "next week") to YYYY-MM-DD.
- Write summaries, comments and notes in ${s.outputLanguage}.
- Prefer the fewest actions that fully capture the item. Do not duplicate actions.
- Use link_dependency when an issue waits on someone or something outside the user's control (a person, a team, a ServiceNow incident).
- Use update_person or update_team only for durable facts (role, responsibilities, how they like to communicate).
- Use remember for rules and preferences the user states about how to handle future work.
- Set each confidence honestly; below 0.6 means you are guessing, so ask a question instead.`;

  const blocks: string[] = [];
  if (s.memories.length) {
    blocks.push(
      `## User rules and preferences\n${s.memories.map((m) => `- (${m.kind}) ${m.content}`).join("\n")}`,
    );
  }
  if (s.examples.length) {
    blocks.push(
      `## Past corrections by the user (learn from these)\n${s.examples
        .map(
          (e) =>
            `- Input: "${e.input}"\n  Proposed: ${e.proposed}\n  ${e.corrected ? `User changed it to: ${e.corrected}` : "User rejected it."}`,
        )
        .join("\n")}`,
    );
  }
  blocks.push(
    `## Directory\nMe: ${s.me?.username ?? "unknown"}\nTeams:\n${
      s.teams
        .map(
          (t) =>
            `- ${t.id}: ${line([t.name, t.function, t.contactFor && `contact for ${t.contactFor}`])}`,
        )
        .join("\n") || "- none"
    }\nPeople:\n${
      s.people
        .map(
          (p) =>
            `- ${p.id}: ${line([p.displayName, p.title, p.team, p.jiraUsername && `jira ${p.jiraUsername}`])}`,
        )
        .join("\n") || "- none"
    }\nJira users: ${s.jiraUsers.map((u) => `${u.username} (${u.displayName})`).join(", ") || "none"}`,
  );
  if (s.notes.length) {
    blocks.push(
      `## Notes\n${s.notes.map((n) => `- About ${n.about}: ${n.title}\n  ${n.excerpt}`).join("\n")}`,
    );
  }
  blocks.push(
    `## Projects\n${s.projects.map((p) => `- ${p.key}: issue types ${p.issueTypes.join(", ") || "unknown"}; statuses ${p.statuses.join(", ") || "unknown"}`).join("\n") || "- none"}\nPriorities: ${s.priorities.join(", ") || "unknown"}`,
  );
  blocks.push(
    `## Candidate issues (the only existing issues you may reference)\n${
      s.candidates
        .map(
          (c) =>
            `- ${c.key} [${c.issueType}, ${c.status}${c.epicKey ? `, epic ${c.epicKey}` : ""}${c.parentKey ? `, parent ${c.parentKey}` : ""}${c.assignee ? `, assignee ${c.assignee}` : ""}] ${c.summary} (${c.reasons.join(", ")})`,
        )
        .join("\n") || "- none found"
    }${s.dependencies.length ? `\nOpen dependencies:\n${s.dependencies.map((d) => `- ${d.issueKey} waits on ${d.label} (${d.status})`).join("\n")}` : ""}`,
  );
  blocks.push(
    `## Input\n${untrusted(s.quote, {
      source: s.source,
      from: s.sender ? line([s.sender.displayName, s.sender.title, s.sender.team]) : null,
    })}\nReferences found by code: issues ${s.references.issueKeys.join(", ") || "none"}; tickets ${s.references.tickets.join(", ") || "none"}.`,
  );

  return { system, prompt: blocks.join("\n\n") };
}

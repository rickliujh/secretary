/**
 * Playbooks at intake (FR-19.7, D61, Phase 26). When classify or the chat
 * proposes a `link_dependency`, or an `update_dependency` that resolves a
 * wait, the playbook replaces that one proposal, before the card is shown,
 * with a bundle in the same thread: the proposal first (the step the others
 * hang on), then the chores. The bundle's id is the proposal's id, and its
 * record (`bundles`) holds the step labels and what the live search found.
 *
 * The only Jira call is the read "find their ticket": a bounded search in the
 * owner's projects (at most 10 results, 8 s each, 3 at a time, 12 s for a
 * turn), whose results are stored out of scope as candidates (D45). No model
 * call; every Jira write stays a proposal. A wait on a ticket the thread has
 * yet to create (`$new:n`, a small ask's Track row) is not expanded.
 */
import { and, eq, inArray, or } from "drizzle-orm";
import { Effect, Option } from "effect";
import {
  dependencies,
  jiraIssues,
  people,
  proposals,
  teams,
  workEvents,
  workItemIssues,
} from "@/db/schema";
import { newId } from "@/lib/ids";
import { logger } from "@/lib/log";
import { query } from "@/services/db";
import { JiraClient } from "@/services/jira";
import { effectiveFieldIds } from "@/services/jira/fields";
import { issueFields } from "@/services/jira/mapping";
import { NEW_REF_RE, type PayloadOf, type ProposalPayload } from "@/services/proposals/schema";
import { Settings, settingsOrDefault } from "@/services/settings";
import type { AppSettings } from "@/services/settings/schema";
import { storeCandidates } from "@/services/sync/candidates";
import { deletedKeys } from "@/services/sync/deleted";
import { getState, parseFieldIds, parseProjectMeta, SYNC_KEYS } from "@/services/sync/state";
import { eventData, type Found, type PlaybookName, type StepDraft } from "../schema";
import { resolvedPlaybook } from "./resolved";
import {
  buildWaitSearchJql,
  FOUND_LIMIT,
  FOUND_TIMEOUT_MS,
  ownerProjects,
  preselect,
  scoreFound,
} from "./search";
import { type WaitingFacts, type WaitingWait, waitingPlaybook } from "./waiting";

/** A proposal of one intake turn, as `mergeItemProposals` returns it. */
export type TurnProposal = {
  payload: ProposalPayload;
  rationale: string;
  evidence: string;
  confidence: number;
  itemIndex: number;
};

/** A proposal to store: the turn's own, or a step a playbook added. */
export type ExpandedProposal = TurnProposal & {
  id: string;
  bundleId: string | null;
  bundleKind: PlaybookName | null;
  /** Its line on the bundle's card. */
  step: { label: string; required: boolean; choice: boolean } | null;
};

/** A bundle's record, without its steps (their `seq` is known once the rows are numbered). */
export type BundleDraft = {
  id: string;
  kind: PlaybookName;
  title: string;
  why: string;
  keys: string[];
  waits: string[];
  facts: Record<string, unknown>;
  found: Found | null;
  /** The proposal it expanded, as the model made it (classify's corrections, revisions). */
  origin: ProposalPayload;
};

/** The chores a thread may already have proposed or dropped itself (Phase 26). */
const CHORE_KINDS: readonly string[] = ["add_comment", "transition_issue", "draft_message"];

/** The tickets a chore acts on. */
export const choreTargets = (p: ProposalPayload): string[] =>
  p.kind === "add_comment" || p.kind === "transition_issue"
    ? [p.target]
    : p.kind === "draft_message"
      ? p.issueKeys
      : [];

/** Searches run at once for one turn, and the most time they get together. */
export const SEARCH_CONCURRENCY = 3;
export const TURN_SEARCH_MS = 12_000;

export type Expanded = { proposals: ExpandedProposal[]; bundles: BundleDraft[] };

const KEY_RE = /^[A-Z][A-Z0-9_]+-\d+$/;
const projectOf = (key: string) => key.split("-")[0] ?? key;

/** The owner of a wait, with what the playbook reads: name, channel, responsiveness, projects. */
const ownerOf = (
  wait: { ownerPersonId: string | null; ownerTeamId: string | null },
  creates: readonly ProposalPayload[],
) =>
  Effect.gen(function* () {
    const person = wait.ownerPersonId
      ? yield* query((d) =>
          d
            .select()
            .from(people)
            .where(eq(people.id, wait.ownerPersonId ?? ""))
            .get(),
        )
      : undefined;
    const teamId = wait.ownerTeamId ?? person?.teamId ?? null;
    const team = teamId
      ? yield* query((d) => d.select().from(teams).where(eq(teams.id, teamId)).get())
      : undefined;
    // A contact or team the same thread proposes adding (D60) is named by its create.
    const created = creates.find(
      (c) =>
        (c.kind === "create_person" && c.ref === wait.ownerPersonId) ||
        (c.kind === "create_team" && c.ref === wait.ownerTeamId),
    );
    const createdName =
      created?.kind === "create_person"
        ? created.displayName
        : created?.kind === "create_team"
          ? created.name
          : null;
    const ownTeam = wait.ownerTeamId ? team : undefined;
    const owned = !!wait.ownerPersonId || !!wait.ownerTeamId;
    return {
      /** Null for a wait with no owner. */
      name: owned
        ? (person?.displayName ?? createdName ?? ownTeam?.name ?? team?.name ?? "someone")
        : null,
      /** A page or an email the mirror can link to without a ticket (D18, `mirrorUrl`). */
      mirrorFallback: !!ownTeam?.confluenceUrls?.[0] || !!person?.email,
      channel:
        person?.profile?.preferredChannel === "email" ? ("email" as const) : ("teams" as const),
      responsiveness: person?.profile?.responsiveness ?? null,
      projects: ownerProjects({
        person: person?.jiraProjects ?? null,
        team: team?.jiraProjects ?? null,
      }),
    };
  });

/**
 * "Find their ticket": the bounded live search. No projects or no words means
 * no search; a failure or a timeout is "Could not search <projects>".
 */
export const findTheirTicket = (opts: {
  projects: readonly string[];
  label: string;
  /** The user's ticket, never offered as theirs. */
  target: string;
  settings: AppSettings;
  /** When the turn's searches must be done (epoch ms); each still gets at most 8 s. */
  deadline?: number;
}) =>
  Effect.gen(function* () {
    const found: Found = { projects: [...opts.projects], error: null, results: [], picked: null };
    const jql = buildWaitSearchJql({ projects: opts.projects, label: opts.label });
    if (!jql) return found;
    const left = Math.min(
      FOUND_TIMEOUT_MS,
      (opts.deadline ?? Number.POSITIVE_INFINITY) - Date.now(),
    );
    if (left <= 0) return { ...found, error: `Could not search ${opts.projects.join(", ")}` };
    // The work pass may run without Jira (tests, no connection set up): then no search.
    const client = yield* Effect.serviceOption(JiraClient);
    if (Option.isNone(client)) return found;
    const jira = client.value;
    const fieldIds = effectiveFieldIds(
      parseFieldIds(yield* getState(SYNC_KEYS.fields)),
      opts.settings.jira.fields,
    );
    const r = yield* Effect.either(
      jira
        .search({ jql, cursor: null, maxResults: FOUND_LIMIT, fields: issueFields(fieldIds) })
        .pipe(Effect.timeout(left)),
    );
    if (r._tag === "Left") {
      logger.info(`Searching ${opts.projects.join(", ")} for "${opts.label}" failed`, r.left);
      return { ...found, error: `Could not search ${opts.projects.join(", ")}` };
    }
    const deleted = yield* deletedKeys;
    const raws = r.right.issues
      .filter((i) => KEY_RE.test(i.key) && i.key !== opts.target && !deleted.has(i.key))
      .slice(0, FOUND_LIMIT);
    // Out of scope, as D45 stores a ticket the input names: offered by its key only.
    yield* storeCandidates(raws).pipe(
      Effect.catchAll((e) =>
        Effect.sync(() => {
          logger.warn("Storing found tickets failed", e.message);
          return [] as string[];
        }),
      ),
    );
    const base = opts.settings.jira.baseUrl.replace(/\/+$/, "");
    const results = scoreFound(
      opts.label,
      raws.map((i) => {
        const f = i.fields as { summary?: unknown; status?: { name?: unknown } | null };
        return {
          key: i.key,
          summary: typeof f.summary === "string" ? f.summary : i.key,
          status: typeof f.status?.name === "string" ? f.status.name : null,
          url: base ? `${base}/browse/${i.key}` : null,
        };
      }),
    );
    return { ...found, results, picked: preselect(results) };
  });

/**
 * Whether the owner already heard about it, or is about to: a message sent to
 * them, or a chase logged, on the ticket or its work item; a draft to them
 * about the ticket still waiting for approval; or the input is their own message.
 */
const askedAlready = (opts: {
  target: string;
  ownerPersonId: string | null;
  ownerTeamId: string | null;
  senderPersonId: string | null;
  /** Proposals this turn replaces: their drafts are going, not about to go out. */
  replacing?: ReadonlySet<string>;
}) =>
  Effect.gen(function* () {
    if (opts.ownerPersonId && opts.senderPersonId === opts.ownerPersonId) return true;
    if (!KEY_RE.test(opts.target)) return false;
    const drafts = yield* query((d) =>
      d
        .select({ id: proposals.id, payload: proposals.payload, edited: proposals.editedPayload })
        .from(proposals)
        .where(and(eq(proposals.kind, "draft_message"), eq(proposals.status, "pending")))
        .all(),
    );
    const pendingDraft = drafts.some((r) => {
      if (opts.replacing?.has(r.id)) return false;
      const p = (r.edited ?? r.payload) as {
        recipientPersonId?: string | null;
        recipientTeamId?: string | null;
        issueKeys?: string[];
      };
      const toOwner =
        (!!opts.ownerPersonId && p.recipientPersonId === opts.ownerPersonId) ||
        (!!opts.ownerTeamId && p.recipientTeamId === opts.ownerTeamId);
      return toOwner && (p.issueKeys ?? []).includes(opts.target);
    });
    if (pendingDraft) return true;
    const item = yield* query((d) =>
      d
        .select({ id: workItemIssues.workItemId })
        .from(workItemIssues)
        .where(eq(workItemIssues.issueKey, opts.target))
        .get(),
    );
    const events = yield* query((d) =>
      d
        .select({ kind: workEvents.kind, data: workEvents.data })
        .from(workEvents)
        .where(
          and(
            inArray(workEvents.kind, ["draft_sent", "wait_chased"]),
            item
              ? or(eq(workEvents.workItemId, item.id), eq(workEvents.issueKey, opts.target))
              : eq(workEvents.issueKey, opts.target),
          ),
        )
        .all(),
    );
    if (events.length === 0) return false;
    const waitIds = events.flatMap((e) => eventData(e.data).dependencyId ?? []);
    const theirs = new Set(
      waitIds.length
        ? (yield* query((d) =>
            d
              .select({
                id: dependencies.id,
                person: dependencies.ownerPersonId,
                team: dependencies.ownerTeamId,
              })
              .from(dependencies)
              .where(inArray(dependencies.id, waitIds))
              .all(),
          ))
            .filter(
              (w) =>
                (!!opts.ownerPersonId && w.person === opts.ownerPersonId) ||
                (!!opts.ownerTeamId && w.team === opts.ownerTeamId),
            )
            .map((w) => w.id)
        : [],
    );
    return events.some((e) => {
      const d = eventData(e.data);
      if (d.dependencyId && theirs.has(d.dependencyId)) return true;
      return !!opts.ownerPersonId && (d.contactIds ?? []).includes(opts.ownerPersonId);
    });
  });

/** The facts the waiting playbook reads for one wait, and its steps. */
export const waitingFor = (opts: {
  wait: WaitingWait;
  dependencyId: string | null;
  senderPersonId: string | null;
  today: string;
  settings: AppSettings;
  /** Creates proposed in the same thread, for names and a new ticket's project. */
  creates?: readonly ProposalPayload[];
  deadline?: number;
  replacing?: ReadonlySet<string>;
}) =>
  Effect.gen(function* () {
    const { wait, settings } = opts;
    const creates = opts.creates ?? [];
    const owner = yield* ownerOf(wait, creates);
    const realKey = KEY_RE.test(wait.target);
    const newTicket = creates.find((c) => c.kind === "create_issue" && c.ref === wait.target);
    const project = realKey
      ? projectOf(wait.target)
      : newTicket?.kind === "create_issue"
        ? newTicket.projectKey
        : null;
    const meta = parseProjectMeta(yield* getState(SYNC_KEYS.projectMeta));
    const row = realKey
      ? yield* query((d) =>
          d
            .select({ status: jiraIssues.status })
            .from(jiraIssues)
            .where(eq(jiraIssues.key, wait.target))
            .get(),
        )
      : undefined;
    // A wait with no owner (an incident, a vendor): nobody's projects to search.
    const found = owner.name
      ? yield* findTheirTicket({
          projects: owner.projects,
          label: wait.label,
          target: wait.target,
          settings,
          deadline: opts.deadline,
        })
      : null;
    const asked = yield* askedAlready({
      target: wait.target,
      ownerPersonId: wait.ownerPersonId,
      ownerTeamId: wait.ownerTeamId,
      senderPersonId: opts.senderPersonId,
      replacing: opts.replacing,
    });
    const playbook = waitingPlaybook({
      wait,
      dependencyId: opts.dependencyId,
      ownerName: owner.name,
      ownerChannel: owner.channel,
      responsiveness: owner.responsiveness,
      followupDays: settings.dependencies.followupDays,
      today: opts.today,
      instructions: settings.secretary.instructions,
      statuses: project ? (meta[project]?.statuses ?? []) : [],
      targetStatus: row?.status ?? null,
      found,
      askedAlready: asked,
      mirrorFallback: owner.mirrorFallback,
    });
    return { ...playbook, found };
  });

/** The facts the resolved playbook reads for one wait, and its steps; null when the wait is gone. */
export const resolvedFor = (opts: {
  resolve: PayloadOf<"update_dependency">;
  settings: AppSettings;
}) =>
  Effect.gen(function* () {
    const dep = yield* query((d) =>
      d.select().from(dependencies).where(eq(dependencies.id, opts.resolve.dependencyId)).get(),
    );
    if (!dep || dep.status === "resolved") return null;
    const owner = yield* ownerOf(dep, []);
    const row = yield* query((d) =>
      d
        .select({ status: jiraIssues.status })
        .from(jiraIssues)
        .where(eq(jiraIssues.key, dep.issueKey))
        .get(),
    );
    const others = (yield* query((d) =>
      d
        .select({ id: dependencies.id, status: dependencies.status })
        .from(dependencies)
        .where(eq(dependencies.issueKey, dep.issueKey))
        .all(),
    )).filter((w) => w.id !== dep.id && w.status !== "resolved");
    const playbook = resolvedPlaybook({
      resolve: opts.resolve,
      wait: {
        id: dep.id,
        issueKey: dep.issueKey,
        label: dep.label,
        ownerName: owner.name ?? dep.label,
        blocked: dep.data?.blocked ?? null,
      },
      targetStatus: row?.status ?? null,
      otherOpenWaits: others.length,
      instructions: opts.settings.secretary.instructions,
    });
    return { ...playbook, wait: dep };
  });

const asStep = (
  base: TurnProposal,
  s: StepDraft,
  bundle: { id: string; kind: PlaybookName },
  origin: boolean,
): ExpandedProposal => ({
  ...base,
  payload: s.payload,
  ...(origin ? {} : { rationale: s.label, evidence: "" }),
  id: origin ? bundle.id : newId(),
  bundleId: bundle.id,
  bundleKind: bundle.kind,
  step: { label: s.label, required: s.required, choice: !!s.choice },
});

/** Expands the playbook proposals of one intake turn; the rest pass through unchanged. */
export const expandTurn = (
  turn: readonly TurnProposal[],
  ctx: {
    senderPersonId: string | null;
    today: string;
    /** Chores this thread already proposed and the user or a revision dropped. */
    dropped?: readonly ProposalPayload[];
    /** Ids of the proposals this turn replaces. */
    replacing?: ReadonlySet<string>;
  },
) =>
  Effect.gen(function* () {
    const settings = yield* settingsOrDefault(yield* Settings);
    const plain = (p: TurnProposal): ExpandedProposal => ({
      ...p,
      id: newId(),
      bundleId: null,
      bundleKind: null,
      step: null,
    });
    // Settings > Secretary off: no playbooks, as no rules.
    if (!settings.work.enabled)
      return { proposals: turn.map(plain), bundles: [] } satisfies Expanded;
    const creates = turn.map((p) => p.payload);
    // A chore the model proposes itself in this turn, or that the thread proposed
    // and the user or a revision dropped, is not added again on the same ticket.
    const avoid = new Set(
      [...creates, ...(ctx.dropped ?? [])].flatMap((p) =>
        CHORE_KINDS.includes(p.kind) ? choreTargets(p).map((t) => `${p.kind}|${t}`) : [],
      ),
    );
    const keep = (steps: StepDraft[]) =>
      steps.filter(
        (s) =>
          s.required ||
          !CHORE_KINDS.includes(s.payload.kind) ||
          !choreTargets(s.payload).some((t) => avoid.has(`${s.payload.kind}|${t}`)),
      );
    const out: ExpandedProposal[] = [];
    const bundles: BundleDraft[] = [];
    // The waits' searches run a few at a time, within one deadline for the turn.
    const deadline = Date.now() + TURN_SEARCH_MS;
    const waits = yield* Effect.forEach(
      turn,
      (p) => {
        const payload = p.payload;
        // A wait on a ticket the thread is yet to create stays in its Track row (D44).
        if (payload.kind !== "link_dependency" || NEW_REF_RE.test(payload.target))
          return Effect.succeed(null);
        const { kind: _k, mirror: _m, ...wait } = payload;
        return waitingFor({
          wait,
          dependencyId: null,
          senderPersonId: ctx.senderPersonId,
          today: ctx.today,
          settings,
          creates,
          deadline,
          replacing: ctx.replacing,
        });
      },
      { concurrency: SEARCH_CONCURRENCY },
    );
    for (const [i, p] of turn.entries()) {
      const payload = p.payload;
      // "Waiting on someone" (or, with no owner, the reduced playbook for an
      // incident or a vendor): with nothing but the wait, it stays one proposal.
      if (payload.kind === "link_dependency" && waits[i]) {
        const pb = { ...waits[i], steps: keep(waits[i]?.steps ?? []) };
        const only = pb.steps.length < 2 && !pb.found?.results.length;
        const first = pb.steps[0];
        if (only && first) {
          out.push({ ...plain(p), payload: first.payload });
          continue;
        }
        const wait = pb.facts;
        const bundle = { id: newId(), kind: "waiting_on_someone" as const };
        pb.steps.forEach((s, i) => {
          out.push(asStep(p, s, bundle, i === 0));
        });
        bundles.push({
          ...bundle,
          title: pb.title,
          why: pb.why,
          keys: KEY_RE.test(wait.target) ? [wait.target] : [],
          waits: [],
          facts: pb.facts satisfies WaitingFacts as Record<string, unknown>,
          found: pb.found,
          origin: payload,
        });
        continue;
      }
      if (payload.kind === "update_dependency" && payload.action === "resolve") {
        const found = yield* resolvedFor({ resolve: payload, settings });
        const pb = found ? { ...found, steps: keep(found.steps) } : null;
        // Nothing to add beyond the resolve: it stays a plain proposal.
        if (!pb || pb.steps.length < 2) {
          out.push(plain(p));
          continue;
        }
        const bundle = { id: newId(), kind: "wait_resolved" as const };
        pb.steps.forEach((s, i) => {
          out.push(asStep(p, s, bundle, i === 0));
        });
        bundles.push({
          ...bundle,
          title: pb.title,
          why: pb.why,
          keys: [pb.wait.issueKey],
          waits: [pb.wait.id],
          facts: {
            dependencyId: pb.wait.id,
            issueKey: pb.wait.issueKey,
            ...(pb.wait.data?.blocked ? { blocked: pb.wait.data.blocked } : {}),
          },
          found: null,
          origin: payload,
        });
        continue;
      }
      out.push(plain(p));
    }
    return { proposals: out, bundles } satisfies Expanded;
  });

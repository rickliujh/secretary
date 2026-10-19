/**
 * Outcome cards (FR-19.6, D61, Phase 25). After every work pass, which follows
 * each sync, triage and decision (even when no model call was made), the
 * consequence rules (`rules.ts`) run for the active items, and each new
 * situation becomes one card: an inbox item (`source` `secretary`) holding the
 * situation, with its steps as pending proposals of one bundle in step order.
 * The user approves them with one click (`Proposals.approveBundle`); nothing
 * here writes to Jira.
 *
 * Idempotent: a situation whose key exists (any status) is not offered again,
 * and what the rules saw is remembered per item (`sync_state` `work.outcomes`),
 * so a moved date or a new event counts once. An item whose situations did not
 * all fit under the cap keeps its old memory, so the rest come next pass.
 */
import { and, asc, eq, gte, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { Effect } from "effect";
import { z } from "zod";
import {
  dependencies,
  inboxItems,
  issueMeta,
  jiraIssues,
  people,
  proposals,
  workEvents,
  workItems,
} from "@/db/schema";
import { localDate, localDateOf } from "@/lib/dates";
import { newId, nowIso } from "@/lib/ids";
import { readJson } from "@/lib/json";
import { logger } from "@/lib/log";
import { blockLinks } from "@/services/dashboard/sections";
import { query } from "@/services/db";
import { listDependencies } from "@/services/dependencies/queries";
import { parseIssueLinks } from "@/services/jira/schemas";
import { parsePayload } from "@/services/proposals/schema";
import type { AppSettings } from "@/services/settings/schema";
import { provenanceDate } from "@/services/small-asks/home";
import { getState, parseProjectMeta, SYNC_KEYS, setState } from "@/services/sync/state";
import { appendEvents, eventsOfItems } from "./events";
import { loadItemFacts } from "./facts";
import { waitingFor } from "./playbooks/expand";
import {
  quietRules,
  RULE_LABELS,
  RULE_NAMES,
  type RuleContact,
  type RuleEvent,
  type RuleMemory,
  type RuleName,
  type RuleRequester,
  type RuleWait,
  runRules,
  situationKey,
  ticketDone,
} from "./rules";
import {
  parseState,
  type Situation,
  type SituationKind,
  type SituationRecord,
  SituationSchema,
  situationOf,
  TIMELINE_ONLY,
} from "./schema";

/** Most new cards one pass offers; the rest wait for the next pass. */
export const OUTCOMES_PER_PASS = 5;

/** An item seen for the first time after the first run: its events of this many hours are new. */
const NEW_ITEM_HOURS = 48;

/** Events of an item the rules read for "nothing sent since" checks. */
const HISTORY_LIMIT = 300;

const MemorySchema = z.object({
  items: z
    .record(
      z.string(),
      z.object({
        nextExpectedOn: z.string().nullable().default(null),
        waits: z.record(z.string(), z.string().nullable()).default({}),
        /** Seen through: the last event the rules read, offered or not. */
        lastEventId: z.string().nullable().default(null),
        /** Situations already known before the rules first ran (kept while they hold); never offered. */
        known: z.array(z.string()).default([]),
        /** Situations found but not offered yet (the cap): offered in a later pass. */
        deferred: z.array(SituationSchema).default([]),
      }),
    )
    .default({}),
});
type OutcomeMemory = z.infer<typeof MemorySchema>;

export type OutcomesResult = { offered: number; situations: number };

const toEvent = (e: typeof workEvents.$inferSelect): RuleEvent => ({
  id: e.id,
  kind: e.kind,
  at: e.at,
  actor: e.actor,
  issueKey: e.issueKey,
  ref: e.ref,
  summary: e.summary,
  data: e.data,
});

/** The rules' quiet list of an item, from its dismissals and "Ask again" events. */
export const quietOfItem = (itemId: string) =>
  Effect.map(
    query((d) =>
      d
        .select({ id: workEvents.id, kind: workEvents.kind, data: workEvents.data })
        .from(workEvents)
        .where(
          and(
            eq(workEvents.workItemId, itemId),
            inArray(workEvents.kind, ["outcome_dismissed", "rule_resumed"]),
          ),
        )
        .all(),
    ),
    quietRules,
  );

/** "Ask again about ..." in the Work tab's item menu: the rule offers cards on the item again. */
export const resumeRule = (itemId: string, rule: RuleName) =>
  appendEvents([
    {
      kind: "rule_resumed",
      actor: "me",
      summary: `Asked again about ${RULE_LABELS[rule].name}`,
      data: { rule } as never,
      workItemId: itemId,
      attachedBy: "user",
      applied: true,
    },
  ]).pipe(Effect.asVoid);

/** Who the rules can write to, with the channel each prefers. */
const loadContacts = Effect.map(
  query((d) =>
    d
      .select({
        id: people.id,
        name: people.displayName,
        jira: people.jiraUsername,
        profile: people.profile,
      })
      .from(people)
      .all(),
  ),
  (rows) => ({
    contacts: new Map(
      rows.map((r): [string, RuleContact] => [
        r.id,
        {
          id: r.id,
          name: r.name,
          channel: r.profile?.preferredChannel === "email" ? "email" : "teams",
        },
      ]),
    ),
    jira: new Map(rows.map((r) => [r.id, r.jira ?? null] as const)),
  }),
);

/** The user's Jira user and the names a comment calls them by (display name, first name). */
const loadMe = Effect.gen(function* () {
  const username = (yield* getState(SYNC_KEYS.username)) ?? null;
  if (!username) return { username: null, names: [] as string[] };
  const row = yield* query((d) =>
    d
      .select({ name: jiraIssues.assigneeDisplay })
      .from(jiraIssues)
      .where(eq(jiraIssues.assignee, username))
      .limit(1)
      .get(),
  );
  const display = row?.name?.trim() ?? "";
  const first = display.split(/\s+/)[0] ?? "";
  return { username, names: [...new Set([display, first].filter((n) => n.length >= 3))] };
});

/** Every "is blocked by" key of these tickets, done or not, from the cached links. */
const blockedByOf = (keys: readonly string[]) =>
  keys.length === 0
    ? Effect.succeed({} as Record<string, string[]>)
    : Effect.map(
        query((d) =>
          d
            .select({ key: jiraIssues.key, raw: jiraIssues.raw })
            .from(jiraIssues)
            .where(inArray(jiraIssues.key, [...keys]))
            .all(),
        ),
        (rows) =>
          Object.fromEntries(
            rows.map((r) => [
              r.key,
              blockLinks(parseIssueLinks((r.raw as { issuelinks?: unknown } | null)?.issuelinks))
                .filter((l) => l.direction === "blockedBy")
                .map((l) => l.key),
            ]),
          ),
      );

/** The smallest id of an event no item holds yet: the watermark never passes it. */
const unattachedFloor = Effect.map(
  query((d) =>
    d
      .select({ id: workEvents.id })
      .from(workEvents)
      .where(isNull(workEvents.attachedBy))
      .orderBy(asc(workEvents.id))
      .limit(1)
      .get(),
  ),
  (r) => r?.id ?? null,
);

/** Creates one card: the inbox item, its steps as one bundle in order, and the timeline event. */
const offer = (item: { id: string; name: string }, s: Situation) =>
  Effect.gen(function* () {
    const id = newId();
    const now = nowIso();
    const record: SituationRecord = {
      rule: s.rule,
      key: s.key,
      title: s.title,
      why: s.why,
      keys: s.keys,
      waits: s.waits,
      comments: s.comments,
      facts: s.facts,
      itemName: item.name,
      steps: s.steps.map((x, seq) => ({
        seq,
        label: x.label,
        required: x.required,
        choice: !!x.choice,
      })),
      found: s.found ?? null,
    };
    yield* query((d) =>
      d.insert(inboxItems).values({
        id,
        source: "secretary",
        rawText: `${s.title}\n${s.why}`,
        receivedAt: now,
        status: "triaged",
        summary: s.title,
        triage: { situation: record },
        workItemId: item.id,
        situationKey: s.key,
      }),
    );
    if (s.steps.length)
      yield* query((d) =>
        d.insert(proposals).values(
          s.steps.map((x, seq) => ({
            id: newId(),
            inboxItemId: id,
            seq,
            kind: x.payload.kind,
            payload: x.payload,
            rationale: x.label,
            status: "pending" as const,
            createdAt: now,
            bundleId: id,
            bundleKind: s.rule,
          })),
        ),
      );
    yield* appendEvents([
      {
        kind: "outcome_offered",
        actor: "secretary",
        issueKey: s.keys[0] ?? null,
        ref: id,
        summary: `Offered: ${s.title}`,
        data: { rule: s.rule, inboxItemId: id, key: s.key } as never,
        workItemId: item.id,
        attachedBy: "code",
        applied: true,
      },
    ]);
    return id;
  });

/** Waits a "wait resolved" bundle resolves or resolved (Phase 26), for `blocker_closed`. */
const handledWaitsOf = Effect.gen(function* () {
  const rows = yield* query((d) =>
    d
      .select({ payload: proposals.payload, edited: proposals.editedPayload })
      .from(proposals)
      .where(
        and(
          eq(proposals.bundleKind, "wait_resolved"),
          eq(proposals.kind, "update_dependency"),
          inArray(proposals.status, ["pending", "approved", "executed"]),
        ),
      )
      .all(),
  );
  const ids = rows.flatMap((r) => {
    const p = parsePayload(r.edited ?? r.payload);
    return p.kind === "update_dependency" ? [p.dependencyId] : [];
  });
  if (ids.length === 0) return [];
  return yield* query((d) =>
    d
      .select({
        issueKey: dependencies.issueKey,
        label: dependencies.label,
        externalRef: dependencies.externalRef,
      })
      .from(dependencies)
      .where(inArray(dependencies.id, ids))
      .all(),
  );
});

/** Requesters on record for these tickets (FR-10.4), with the day they asked. */
const requestersOf = (keys: readonly string[]) =>
  keys.length === 0
    ? Effect.succeed({} as Record<string, RuleRequester>)
    : Effect.map(
        query((d) =>
          d
            .select({
              key: issueMeta.issueKey,
              personId: issueMeta.requesterPersonId,
              name: people.displayName,
              description: jiraIssues.description,
              created: jiraIssues.created,
            })
            .from(issueMeta)
            .innerJoin(people, eq(people.id, issueMeta.requesterPersonId))
            .leftJoin(jiraIssues, eq(jiraIssues.key, issueMeta.issueKey))
            .where(
              and(inArray(issueMeta.issueKey, [...keys]), isNotNull(issueMeta.requesterPersonId)),
            )
            .all(),
        ),
        (rows) =>
          Object.fromEntries(
            rows.map((r) => [
              r.key,
              {
                personId: r.personId ?? "",
                name: r.name,
                askedOn:
                  provenanceDate(r.description) ?? (r.created ? localDateOf(r.created) : null),
              } satisfies RuleRequester,
            ]),
          ),
      );

/**
 * Waits opened since the last run that no playbook bundle made (Phase 26): one
 * from the dependency dialog, or approved before playbooks existed. Each gets
 * the "waiting on someone" card for the chores, without the wait step (the
 * reduced one for a wait with no owner). A wait a rule's card of the same pass
 * is about (a chase already due) keeps only what that card does not do: no
 * second draft and no second comment.
 */
const waitingCards = (opts: {
  item: { id: string; name: string };
  waits: readonly RuleWait[];
  previous: RuleMemory | null;
  settings: AppSettings;
  today: string;
  /** Waits the rules' situations of this pass are about. */
  covered: ReadonlySet<string>;
}) =>
  Effect.gen(function* () {
    if (!opts.previous) return [] as Situation[];
    const fresh = opts.waits.filter((w) => !Object.hasOwn(opts.previous?.waits ?? {}, w.id));
    if (fresh.length === 0) return [];
    const bundled = new Set(
      (yield* query((d) =>
        d
          .select({ result: proposals.result })
          .from(proposals)
          .where(
            and(
              eq(proposals.kind, "link_dependency"),
              eq(proposals.bundleKind, "waiting_on_someone"),
              inArray(proposals.status, ["executed", "revoked"]),
            ),
          )
          .all(),
      )).flatMap((r) => (r.result as { dependencyId?: string } | null)?.dependencyId ?? []),
    );
    const out: Situation[] = [];
    for (const w of fresh) {
      if (bundled.has(w.id)) continue;
      const row = yield* query((d) =>
        d.select().from(dependencies).where(eq(dependencies.id, w.id)).get(),
      );
      if (!row) continue;
      const pb = yield* waitingFor({
        wait: {
          target: row.issueKey,
          dependencyKind: row.kind,
          label: row.label,
          ownerPersonId: row.ownerPersonId,
          ownerTeamId: row.ownerTeamId,
          externalRef: row.externalRef,
          externalUrl: row.externalUrl,
          expectedAt: row.expectedAt,
          nextFollowupAt: row.nextFollowupAt,
        },
        dependencyId: row.id,
        senderPersonId: null,
        today: opts.today,
        settings: opts.settings,
      });
      const steps = opts.covered.has(w.id)
        ? pb.steps.filter(
            (s) => s.payload.kind !== "draft_message" && s.payload.kind !== "add_comment",
          )
        : pb.steps;
      if (steps.length === 0) continue;
      out.push({
        rule: "waiting_on_someone",
        key: situationKey("waiting_on_someone", opts.item.id, { wait: w.id }),
        title: pb.title,
        why: pb.why,
        keys: [w.issueKey],
        waits: [w.id],
        comments: [],
        facts: pb.facts,
        steps,
        found: pb.found,
      });
    }
    return out;
  });

/**
 * Runs the rules for every active item and offers what is new: at most
 * `OUTCOMES_PER_PASS` cards, the current item first, then in the rules'
 * priority order. Items closed in the last two days run `ticket_done` only
 * (an item closes when its last primary ticket is done, Phase 26).
 */
export const runOutcomes = (opts: { now: Date; settings: AppSettings }) =>
  Effect.gen(function* () {
    const today = localDate(opts.now);
    const raw = yield* getState(SYNC_KEYS.outcomes);
    const first = raw === undefined;
    const memory: OutcomeMemory = readJson(raw, MemorySchema, { items: {} });
    const closedSince = new Date(opts.now.getTime() - NEW_ITEM_HOURS * 3_600_000).toISOString();
    const items = yield* query((d) =>
      d
        .select({
          id: workItems.id,
          name: workItems.name,
          current: workItems.current,
          state: workItems.state,
          status: workItems.status,
        })
        .from(workItems)
        .where(
          or(
            eq(workItems.status, "active"),
            and(eq(workItems.status, "done"), gte(workItems.closedAt, closedSince)),
          ),
        )
        .orderBy(asc(workItems.createdAt), asc(workItems.id))
        .all(),
    );
    const deps = yield* listDependencies();
    const { contacts, jira } = yield* loadContacts;
    const me = yield* loadMe;
    const meta = parseProjectMeta(yield* getState(SYNC_KEYS.projectMeta));
    const statuses = Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, v.statuses]));
    const pending = (yield* query((d) =>
      d
        .select({ payload: proposals.payload, editedPayload: proposals.editedPayload })
        .from(proposals)
        .where(eq(proposals.status, "pending"))
        .all(),
    )).map((p) => parsePayload(p.editedPayload ?? p.payload));
    const floor = yield* unattachedFloor;
    const handled = yield* handledWaitsOf;
    const cutoff = new Date(opts.now.getTime() - NEW_ITEM_HOURS * 3_600_000).toISOString();

    const found: { item: (typeof items)[number]; index: number; s: Situation }[] = [];
    const seen = new Map<string, RuleMemory & { known: string[] }>();
    for (const [index, item] of items.entries()) {
      const facts = yield* loadItemFacts(item.id, { today });
      const keys = new Set(facts.tickets.map((t) => t.key));
      const waits = deps
        .filter((w) => keys.has(w.issueKey) && w.status !== "resolved")
        .map(
          (w): RuleWait => ({
            id: w.id,
            issueKey: w.issueKey,
            label: w.label,
            status: w.status,
            externalRef: w.externalRef,
            ownerPersonId: w.ownerPersonId,
            ownerTeamId: w.ownerTeamId,
            ownerName: w.owner.name,
            ownerJira: w.ownerPersonId ? (jira.get(w.ownerPersonId) ?? null) : null,
            requestedAt: w.requestedAt,
            expectedAt: w.expectedAt,
            nextFollowupAt: w.nextFollowupAt,
            lastFollowupAt: w.lastFollowupAt,
            ownerAway: w.ownerAway,
            data: w.data ?? null,
          }),
        );
      const history = (yield* eventsOfItems([item.id], HISTORY_LIMIT)).map(toEvent);
      const prev = memory.items[item.id] ?? null;
      const isNew = (e: RuleEvent) => {
        if (TIMELINE_ONLY.has(e.kind as never)) return false;
        if (prev) return !prev.lastEventId || e.id > prev.lastEventId;
        // The first run ever reads no old news; an item first seen later reads its last two days.
        if (first) return false;
        return e.at >= cutoff;
      };
      const newEvents = history.filter(isNew);
      // The watermark stops before an event no item holds yet, so it is read once attached.
      const readable = history.map((e) => e.id).filter((x) => !floor || x < floor);
      const lastEventId =
        [prev?.lastEventId ?? null, ...readable]
          .filter((x): x is string => !!x)
          .sort()
          .at(-1) ?? null;
      const state = parseState(item.state);
      const input = {
        item,
        facts,
        state,
        previous: prev,
        newEvents,
        history,
        waits,
        blockedBy: yield* blockedByOf(facts.tickets.map((t) => t.key)),
        statuses,
        contacts,
        me,
        pending,
        today,
        settings: opts.settings,
        quiet: yield* quietOfItem(item.id),
        requesters: yield* requestersOf(facts.tickets.map((t) => t.key)),
        handledWaits: handled,
      };
      // A finished item only tidies up after its done ticket.
      const ruled = item.status === "active" ? runRules(input) : [];
      const situations =
        item.status === "active"
          ? [
              ...ruled,
              ...(yield* waitingCards({
                item,
                waits,
                previous: prev,
                settings: opts.settings,
                today,
                covered: new Set(ruled.flatMap((s) => s.waits)),
              })),
            ]
          : opts.settings.secretary.rules.ticket_done && !input.quiet.has("ticket_done")
            ? ticketDone(input)
            : [];
      // Those found now, and those an earlier pass left for later; the fresh one wins.
      const now = new Set(situations.map((s) => s.key));
      const candidates = [...situations, ...(prev?.deferred ?? []).filter((s) => !now.has(s.key))];
      // The first run ever offers nothing: what holds already (a chase due, a
      // promise late) is known, and only what changes from then on is offered.
      const known = first ? [...now] : (prev?.known ?? []).filter((k) => now.has(k));
      const knownSet = new Set(known);
      for (const s of candidates) if (!knownSet.has(s.key)) found.push({ item, index, s });
      // Seen through is advanced for every item, offered or not.
      seen.set(item.id, {
        nextExpectedOn: state?.nextExpected?.on ?? null,
        waits: Object.fromEntries(waits.map((w) => [w.id, w.expectedAt])),
        lastEventId,
        known,
      });
    }

    const rank = (x: (typeof found)[number]) => {
      const i = RULE_NAMES.indexOf(x.s.rule as RuleName);
      return i < 0 ? RULE_NAMES.length : i;
    };
    found.sort(
      (a, b) =>
        Number(b.item.current) - Number(a.item.current) || rank(a) - rank(b) || a.index - b.index,
    );
    const keys = [...new Set(found.map((x) => x.s.key))];
    const existing = new Set(
      keys.length
        ? (yield* query((d) =>
            d
              .select({ key: inboxItems.situationKey })
              .from(inboxItems)
              .where(inArray(inboxItems.situationKey, keys))
              .all(),
          )).map((r) => r.key)
        : [],
    );
    const fresh: typeof found = [];
    for (const x of found) {
      if (existing.has(x.s.key)) continue;
      existing.add(x.s.key);
      fresh.push(x);
    }
    const offered = fresh.slice(0, OUTCOMES_PER_PASS);
    const left = fresh.slice(OUTCOMES_PER_PASS);
    const deferred = new Set(left.map((x) => x.item.id));
    for (const x of offered) yield* offer(x.item, x.s);

    // Only active items are remembered; what did not fit under the cap waits in `deferred`.
    const items2: OutcomeMemory["items"] = {};
    for (const item of items.filter((i) => i.status === "active")) {
      const kept = seen.get(item.id);
      if (!kept) continue;
      items2[item.id] = {
        ...kept,
        deferred: left
          .filter((x) => x.item.id === item.id)
          .flatMap((x) => {
            const parsed = SituationSchema.safeParse(x.s);
            return parsed.success ? [parsed.data] : [];
          }),
      };
    }
    yield* setState(SYNC_KEYS.outcomes, JSON.stringify({ items: items2 } satisfies OutcomeMemory));
    if (offered.length)
      logger.info(
        `Outcomes: ${offered.length} new card${offered.length === 1 ? "" : "s"}${deferred.size ? `, more next pass` : ""}`,
      );
    return { offered: offered.length, situations: fresh.length } satisfies OutcomesResult;
  });

/** Pending outcome cards (Today's "Your move"): title, item, steps, and the tickets they are about. */
export const pendingOutcomes = Effect.gen(function* () {
  const cards = yield* query((d) =>
    d
      .select({
        id: inboxItems.id,
        triage: inboxItems.triage,
        receivedAt: inboxItems.receivedAt,
        workItemId: inboxItems.workItemId,
        itemName: workItems.name,
      })
      .from(inboxItems)
      .leftJoin(workItems, eq(workItems.id, inboxItems.workItemId))
      .where(and(eq(inboxItems.source, "secretary"), eq(inboxItems.status, "triaged")))
      .orderBy(asc(inboxItems.receivedAt))
      .all(),
  );
  if (cards.length === 0) return [];
  const steps = yield* query((d) =>
    d
      .select({ bundleId: proposals.bundleId })
      .from(proposals)
      .where(
        and(
          inArray(
            proposals.bundleId,
            cards.map((c) => c.id),
          ),
          eq(proposals.status, "pending"),
        ),
      )
      .all(),
  );
  const count = new Map<string, number>();
  for (const s of steps) if (s.bundleId) count.set(s.bundleId, (count.get(s.bundleId) ?? 0) + 1);
  return cards.flatMap((c) => {
    const record = situationOf(c.triage);
    if (!record) return [];
    return [
      {
        id: c.id,
        rule: record.rule,
        title: record.title,
        why: record.why,
        itemName: c.itemName ?? record.itemName,
        workItemId: c.workItemId,
        steps: count.get(c.id) ?? 0,
        keys: record.keys,
        waits: record.waits,
        comments: record.comments,
        at: c.receivedAt,
      } satisfies OutcomeRef,
    ];
  });
});

/** An open outcome card as Today lists it. */
export type OutcomeRef = {
  id: string;
  rule: SituationKind;
  title: string;
  why: string;
  itemName: string;
  workItemId: string | null;
  /** Steps still to decide. */
  steps: number;
  keys: string[];
  /** The waits it is about: Today hides only these wait rows. */
  waits: string[];
  /** The comments it is about (`teammate_touched`): Today hides their comment rows. */
  comments: string[];
  at: string;
};

/** The rules quiet on an item, for the Work tab's "Ask again about ..." */
export const quietRulesOf = (itemId: string) => Effect.map(quietOfItem(itemId), (s) => [...s]);

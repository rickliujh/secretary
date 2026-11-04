import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { Effect, Either, Layer } from "effect";
import {
  bundles,
  inboxItems,
  inboxMessages,
  intakeItems,
  jiraIssues,
  memories,
  people,
  proposals,
  workEvents,
} from "@/db/schema";
import { localDate } from "@/lib/dates";
import { newId, nowIso } from "@/lib/ids";
import { logger } from "@/lib/log";
import {
  buildClassifyPrompt,
  buildItemSchema,
  fromPayload,
  type ItemOutput,
  type ItemSnapshot,
  type MappedProposal,
  mapItemOutput,
  type ThreadContext,
  validateItemOutput,
} from "@/prompts/classify";
import {
  buildRouteReplyPrompt,
  buildRouteReplySchema,
  type RouteReplyOutput,
  validateRouteReply,
} from "@/prompts/route-reply";
import {
  buildSegmentPrompt,
  type SegmentOutput,
  SegmentOutputSchema,
  validateSegments,
} from "@/prompts/segment";
import { bindDb, Db } from "@/services/db";
import { JiraClient } from "@/services/jira";
import { type CallHooks, Llm, type LlmError, RETRYABLE_KINDS } from "@/services/llm";
import {
  createdIds,
  describePayload,
  effectivePayload,
  issueRefs,
  ownRef,
  type ProposalPayload,
  ProposalPayloadSchema,
  placeholderRefs,
  resolveRefs,
  withoutCodeFields,
} from "@/services/proposals/schema";
import { Retrieval } from "@/services/retrieval";
import { Settings, settingsOrDefault } from "@/services/settings";
import { Sync } from "@/services/sync";
import { deletedKeys } from "@/services/sync/deleted";
import { EVENT_TEXT_CHARS, recordEvents } from "@/services/work/events";
import { takeUp } from "@/services/work/park";
import { CHORE_KINDS, choreTargets, expandTurn } from "@/services/work/playbooks/expand";
import { revisionPayload } from "@/services/work/playbooks/waiting";
import { answerWorkQuestion, postMessage } from "@/services/work/questions";
import {
  type Actor,
  bundleRecordOf,
  type MessageData,
  type SituationRecord,
} from "@/services/work/schema";
import {
  Intake,
  IntakeError,
  ownWordsSource,
  type ReplyInput,
  type Source,
  type TriageInput,
  type TriageResult,
  type TurnControl,
  type Withdrawn,
} from ".";
import { threadOutcomes } from "./decided";
import { mergeItemProposals } from "./merge";
import {
  cleanInput,
  extractReferences,
  jiraHost,
  needsSegmentation,
  type References,
} from "./preprocess";
import {
  lastTurnOf,
  type RunRecord,
  runRecordOf,
  type StoredJob,
  unreadOf,
  unreadWith,
} from "./record";
import type { RunEvent, StepName } from "./runs";
import {
  hasInput,
  mergeParts,
  partsOf,
  plainQuotes,
  splitMessage,
  UserContentSchema,
  withLinkedItems,
} from "./thread";

const UNSURE_QUESTION =
  "I am not sure what should happen here. What would you like me to do with this?";
const FAILED_QUESTION = "I could not turn this into reliable actions";

/** A question code asks, not the model: it quotes the input, so it says nothing of the topic. */
const codeQuestion = (q: string) => q === UNSURE_QUESTION || q.startsWith(FAILED_QUESTION);

type ProposalRow = typeof proposals.$inferSelect;
type ItemRow = typeof intakeItems.$inferSelect;

/** How a turn reports and is steered (D68): events out, the user's skip and tier in. */
type Ctl = {
  emit: (e: RunEvent) => void;
  skip?: TurnControl["skip"];
  tier?: TurnControl["tier"];
};

/** Events for a run; the older string progress is each step's title as it starts. */
const controlOf = (c: TurnControl | undefined): Ctl => ({
  emit: (e) => {
    c?.onEvent?.(e);
    if (e.type === "step" && e.phase === "start") c?.onProgress?.(e.title);
  },
  ...(c?.skip ? { skip: c.skip } : {}),
  ...(c?.tier ? { tier: c.tier } : {}),
});

const step = (
  ctl: Ctl,
  name: StepName,
  phase: "start" | "end",
  title: string,
  extra: { item?: number; count?: number; detail?: string } = {},
) => ctl.emit({ type: "step", at: Date.now(), name, phase, title, ...extra });

/** A model call's attempts as run events (D68). */
const hooksOf = (ctl: Ctl, item?: number): CallHooks => ({
  onAttempt: (attempt) =>
    ctl.emit({ type: "attempt", at: attempt.at, ...(item === undefined ? {} : { item }), attempt }),
  ...(ctl.skip ? { skip: ctl.skip } : {}),
});

/** A few words of an item for its step: the start of its first line. */
const excerpt = (quote: string) => {
  const line = quote.trim().split("\n")[0]?.trim() ?? "";
  return line.length > 48 ? `${line.slice(0, 47)}…` : line;
};

/** Most tickets missing from the cache read from Jira for one item. */
const MAX_KEY_READS = 5;

type Job = {
  idx: number;
  quote: string;
  instructions: string[];
  /** Undecided proposals being revised; empty for new input. */
  revising: ProposalRow[];
  /** The day the item first arrived, for a revision (D44: "Asked ... on" keeps it). */
  askedOn?: string;
  /** Where the item's own input came from; a revision keeps it. Default: the turn's. */
  source?: string;
  /** The input is the user's own typed words, not pasted and not the chat's (D55). */
  ownInput: boolean;
  /** The questions the model asked about this item so far (D55 answers). */
  questions?: string[];
  /** Proposals this turn replaces (every revised item's), so none is offered as existing. */
  replacing?: ReadonlySet<string>;
  /** Its place in the turn, from 0, and the turn's size; a resume keeps the first ones (D68). */
  pos?: number;
  count?: number;
};

/** A job with its place in the turn. */
type Placed = Job & { pos: number; count: number };

const storedJob = (j: Placed): StoredJob => ({
  idx: j.idx,
  pos: j.pos,
  count: j.count,
  quote: j.quote,
  instructions: j.instructions,
  ...(j.source ? { source: j.source } : {}),
  ownInput: j.ownInput,
});

type Classified = {
  itemId: string;
  /** Its intake item, written with its cards (D68). */
  row: typeof intakeItems.$inferInsert;
  mapped: MappedProposal[];
  question: string | null;
  summary: string | null;
  /** The work event this item becomes (D61): one per intake item and revision. */
  event: Omit<MessageData, "inboxItemId"> & { at: string };
};

const noRefs: References = { issueKeys: [], tickets: [], emails: [], urls: [], contactIds: [] };

const mergeRefs = (a: References, b: References): References => ({
  issueKeys: [...new Set([...a.issueKeys, ...b.issueKeys])],
  tickets: [...new Set([...a.tickets, ...b.tickets])],
  emails: [...new Set([...a.emails, ...b.emails])],
  urls: [...new Set([...a.urls, ...b.urls])],
  contactIds: [...new Set([...a.contactIds, ...b.contactIds])],
});

const make = Effect.gen(function* () {
  const llm = yield* Llm;
  const retrieval = yield* Retrieval;
  const sync = yield* Sync;
  const settingsSvc = yield* Settings;
  const jira = yield* JiraClient;
  const { q, withDb } = bindDb(yield* Db);

  /**
   * Keys Jira answered for in this session (found, 404 or 403), so each is read
   * once (D45); a transient failure is not recorded, so a later item retries it.
   */
  const readKeys = new Set<string>();
  /**
   * A ticket named in the text that the cache does not hold (outside the sync
   * scope, such as another team's PLAT-812) is read once from Jira, so it can be
   * a candidate, for example as a blocker (D45). Pasted text is untrusted and
   * must not widen the scope, so it is stored out of scope (`candidate`): it is
   * offered by its key and nowhere else. A failure only leaves it out.
   */
  const readMissingKeys = (keys: readonly string[]) =>
    Effect.gen(function* () {
      const fresh = [...new Set(keys)].filter((k) => !readKeys.has(k));
      if (fresh.length === 0) return;
      const cached = new Set(
        (yield* q((d) =>
          d
            .select({ key: jiraIssues.key })
            .from(jiraIssues)
            .where(and(inArray(jiraIssues.key, fresh), eq(jiraIssues.stale, false)))
            .all(),
        )).map((r) => r.key),
      );
      for (const key of fresh.filter((k) => !cached.has(k)).slice(0, MAX_KEY_READS)) {
        const r = yield* Effect.either(sync.refreshIssue(key, { candidate: true }));
        const status = Either.isLeft(r) && r.left._tag === "JiraError" ? r.left.status : undefined;
        if (Either.isRight(r) || status === 404 || status === 403) readKeys.add(key);
        if (Either.isLeft(r)) logger.info(`${key} named in the input was not read`, r.left.message);
      }
    });

  const contactsQuery = q((d) =>
    d
      .select({
        id: people.id,
        displayName: people.displayName,
        email: people.email,
        jiraUsername: people.jiraUsername,
      })
      .from(people)
      .all(),
  );

  /** Splits long input; falls back to one item if segmentation cannot be trusted. */
  const segment = (text: string, source: string, ctl: Ctl) =>
    Effect.gen(function* () {
      if (!needsSegmentation(text)) return [text];
      step(ctl, "split", "start", "Splitting into items");
      const quotes = yield* llm
        .object<SegmentOutput>("segment_input", {
          schema: SegmentOutputSchema,
          ...buildSegmentPrompt(text, source),
          validate: (out) => validateSegments(out, text),
          ...(ctl.tier ? { tier: ctl.tier } : {}),
          hooks: hooksOf(ctl),
        })
        .pipe(
          Effect.map((r) =>
            r.value.items.length > 0 ? r.value.items.map((i) => i.quote.trim()) : [text],
          ),
          // A bad split is not worth asking about: classify the whole text as one item.
          Effect.catchIf(
            (e) => e.kind === "schema",
            () => Effect.succeed([text]),
          ),
        );
      step(ctl, "split", "end", "Split into items", {
        count: quotes.length,
        detail: quotes.length === 1 ? "1 item" : `${quotes.length} items`,
      });
      return quotes;
    });

  /** Everything a turn needs to know about the thread so far. */
  const loadThread = (inboxItemId: string) =>
    Effect.gen(function* () {
      const item = yield* q((d) =>
        d.select().from(inboxItems).where(eq(inboxItems.id, inboxItemId)).get(),
      );
      if (!item)
        return yield* new IntakeError({
          kind: "not_found",
          message: "That inbox item no longer exists.",
        });
      const messages = yield* q((d) =>
        d
          .select()
          .from(inboxMessages)
          .where(eq(inboxMessages.inboxItemId, inboxItemId))
          .orderBy(asc(inboxMessages.seq))
          .all(),
      );
      const rows = yield* q((d) =>
        d
          .select()
          .from(proposals)
          .where(eq(proposals.inboxItemId, inboxItemId))
          .orderBy(asc(proposals.seq))
          .all(),
      );
      const itemRows = yield* q((d) =>
        d.select().from(intakeItems).where(eq(intakeItems.inboxItemId, inboxItemId)).all(),
      );
      // Each turn that revises an item adds a row for it; the newest one is current.
      const current = new Map<number, ItemRow>();
      for (const r of [...itemRows].sort((a, b) => a.id.localeCompare(b.id))) current.set(r.idx, r);
      const idxOf = new Map(itemRows.map((r) => [r.id, r.idx]));

      const userMessages = messages.filter((m) => m.role === "user");
      const instructions = userMessages.flatMap((m, i) => {
        const c = UserContentSchema.safeParse(m.content);
        if (!c.success) return [];
        return (
          splitMessage(c.data.parts, i === 0 || !!c.data.asInput, c.data.inline).instruction ?? []
        );
      });
      // Typed input written in the message box may hold «...» values (D56); older
      // typed input's own « and » are plain quotes, so they never read as one.
      const firstInline = !!UserContentSchema.safeParse(userMessages[0]?.content).data?.inline;
      // A ticket a revoke closed without moving it shows its status as cached now.
      const revokedKeys = rows
        .filter((r) => r.kind === "create_issue" && r.status === "revoked")
        .map((r) => (r.result as { issueKey?: string } | null)?.issueKey)
        .filter((k): k is string => !!k);
      const cachedStatus = new Map(
        revokedKeys.length
          ? (yield* q((d) =>
              d
                .select({ key: jiraIssues.key, status: jiraIssues.status })
                .from(jiraIssues)
                .where(inArray(jiraIssues.key, revokedKeys))
                .all(),
            )).map((r) => [r.key, r.status] as const)
          : [],
      );
      const { decided, createdKeys, deletedKeys } = threadOutcomes(
        rows,
        (key) => cachedStatus.get(key) ?? null,
      );
      const pendingByIdx = new Map<number, ProposalRow[]>();
      for (const r of rows) {
        if (r.status !== "pending" || !r.intakeItemId) continue;
        const idx = idxOf.get(r.intakeItemId);
        if (idx === undefined) continue;
        pendingByIdx.set(idx, [...(pendingByIdx.get(idx) ?? []), r]);
      }
      // The model's questions per item, answered or not; code's own fallbacks left out.
      const questionsByIdx = new Map<number, string[]>();
      for (const r of rows) {
        if (r.kind !== "needs_clarification" || !r.intakeItemId) continue;
        const idx = idxOf.get(r.intakeItemId);
        const question = (r.payload as { question?: string }).question ?? "";
        if (idx === undefined || !question || codeQuestion(question)) continue;
        questionsByIdx.set(idx, [...(questionsByIdx.get(idx) ?? []), question]);
      }
      // The chat wrote the first message for the user (propose_actions): not their words.
      const first = UserContentSchema.safeParse(userMessages[0]?.content);
      const chatAuthored = first.success && first.data.author === "chat";
      // A note block that quotes someone with ">" has that quote as its input (D65).
      const firstPasted =
        first.success && hasInput(first.data.parts, !!first.data.inline) && !!first.data.inline;
      return {
        item,
        messages,
        rows,
        current,
        idxOf,
        instructions,
        firstInline,
        decided,
        createdKeys,
        deletedKeys,
        revokedKeys,
        pendingByIdx,
        questionsByIdx,
        chatAuthored,
        firstPasted,
      };
    });
  type Thread = Effect.Effect.Success<ReturnType<typeof loadThread>>;
  type Ctx = { thread: Thread; source: string; senderPersonId: string | null; today: string };

  /** How much of each other item in a thread the model sees. */
  const OTHER_QUOTE_CHARS = 600;

  /** What one item is read with: its candidates, the thread, the people (D68: before any call). */
  const prepareItem = (inboxItemId: string, job: Job, ctx: Ctx) =>
    Effect.gen(function* () {
      const contacts = yield* contactsQuery;
      // New contacts and teams the thread's other items propose, not added yet
      // (D60): listed by their ref, so this item uses them instead of a second one.
      const threadCreates = ctx.thread.rows.flatMap(
        (r): NonNullable<ItemSnapshot["threadCreates"]> => {
          if (!["pending", "approved", "failed"].includes(r.status)) return [];
          if (job.replacing?.has(r.id) || job.revising.some((x) => x.id === r.id)) return [];
          const p = effectivePayload(r);
          if (p.kind === "create_person")
            return [{ ref: p.ref, kind: "person" as const, name: p.displayName }];
          if (p.kind === "create_team")
            return [{ ref: p.ref, kind: "team" as const, name: p.name }];
          return [];
        },
      );
      const taken = new Set(threadCreates.map((c) => c.ref));
      // Stored refs -> $new:1.., $person:1.., $team:1.. for the model, around the
      // refs listed above; the merge renumbers them afterwards.
      const local = new Map<string, string>();
      const counts = new Map<string, number>();
      for (const r of job.revising) {
        const own = ownRef(effectivePayload(r));
        if (!own || local.has(own)) continue;
        const ns = own.slice(0, own.indexOf(":"));
        let n = (counts.get(ns) ?? 0) + 1;
        while (taken.has(`${ns}:${n}`)) n++;
        counts.set(ns, n);
        local.set(own, `${ns}:${n}`);
      }
      // What the thread's approved creates already made stands in for their refs.
      const made = createdIds(ctx.thread.rows);
      // The sprint switch the user set stays through the revision (D57); code's, never the model's.
      const sprintChoices: Record<string, boolean> = {};
      for (const r of job.revising) {
        const p = effectivePayload(r);
        const ref = p.kind === "create_issue" ? local.get(p.ref) : undefined;
        if (p.kind === "create_issue" && p.joinSprintChosen && ref)
          sprintChoices[ref] = p.joinSprint;
      }
      // The thread's playbook bundles (Phase 26): what the model made before expansion.
      const records = new Map(
        (yield* q((d) =>
          d.select().from(bundles).where(eq(bundles.inboxItemId, inboxItemId)).all(),
        )).map((b) => [b.id, bundleRecordOf(b.record)] as const),
      );
      const pending = job.revising.flatMap((r) => {
        if (r.kind === "needs_clarification") return [];
        // A playbook's own steps are code's chores, not the model's proposals (Phase 26):
        // the proposal it expanded is revised as the model made it (or as the user
        // edited it, without the ticket the search found), and expands again.
        if (r.bundleId && r.bundleId !== r.id) return [];
        const record = r.bundleId ? records.get(r.bundleId) : null;
        const origin = record?.origin ? ProposalPayloadSchema.safeParse(record.origin) : null;
        const payload = record
          ? revisionPayload({
              current: effectivePayload(r),
              edited: !!r.editedPayload,
              origin: origin?.success ? origin.data : null,
              found: record.found,
            })
          : effectivePayload(r);
        const shape = fromPayload(resolveRefs(payload, made), local);
        return shape
          ? [
              {
                ...shape,
                rationale: r.rationale ?? "",
                evidence: r.evidence ?? "",
                confidence: r.confidence ?? 0.5,
              },
            ]
          : [];
      });
      // The thread's other items: what "it" or "that ticket" may point at (D22).
      const others = [...ctx.thread.current]
        .filter(([idx]) => idx !== job.idx)
        .sort(([a], [b]) => a - b)
        .map(([, row]) => ({
          summary: row.summary ?? null,
          quote: row.quote.slice(0, OTHER_QUOTE_CHARS),
        }));
      const questions = job.questions ?? [];
      const thread: ThreadContext | null =
        job.instructions.length ||
        pending.length ||
        ctx.thread.decided.length ||
        others.length ||
        questions.length
          ? {
              instructions: job.instructions,
              decided: ctx.thread.decided,
              pending,
              others,
              ...(questions.length ? { questions } : {}),
              ...(Object.keys(sprintChoices).length ? { sprintChoices } : {}),
            }
          : null;
      const site = { jiraHost: jiraHost((yield* settingsOrDefault(settingsSvc)).jira.baseUrl) };
      const named = [
        extractReferences(job.quote, contacts, site),
        extractReferences(job.instructions.join("\n"), contacts, site),
        // Tickets named anywhere earlier in the thread stay candidates for this item.
        ...others.map((o) => extractReferences(o.quote, contacts, site)),
        {
          ...noRefs,
          issueKeys: [
            ...ctx.thread.rows.flatMap((r) => issueRefs(effectivePayload(r), { only: "keys" })),
            ...ctx.thread.createdKeys,
          ],
        },
      ].reduce(mergeRefs);
      // A ticket a revoke deleted, in this thread or any other, no longer exists
      // (FR-14.6): not read, not named as a reference, and retrieval leaves it out
      // however it would find it.
      const deleted = new Set([...ctx.thread.deletedKeys, ...(yield* withDb(deletedKeys))]);
      const references = {
        ...named,
        issueKeys: named.issueKeys.filter((k) => !deleted.has(k)),
      };
      const exclude = [
        ...new Set([...ctx.thread.deletedKeys, ...named.issueKeys.filter((k) => deleted.has(k))]),
      ];
      yield* readMissingKeys(references.issueKeys);
      const source = job.source ?? ctx.source;
      // What the item itself names, for attaching its work event (D61).
      const own = mergeRefs(
        extractReferences(job.quote, contacts, site),
        extractReferences(job.instructions.join("\n"), contacts, site),
      );
      const instruction = job.instructions.join("\n").trim();
      const eventOf = (itemId: string): Classified["event"] => ({
        at: nowIso(),
        intakeItemId: itemId,
        quote: job.quote.slice(0, EVENT_TEXT_CHARS),
        instruction: instruction ? instruction.slice(0, EVENT_TEXT_CHARS) : null,
        keys: own.issueKeys.filter((k) => !deleted.has(k)),
        contactIds: [
          ...new Set([...own.contactIds, ...(ctx.senderPersonId ? [ctx.senderPersonId] : [])]),
        ],
        senderPersonId: ctx.senderPersonId,
        source,
        ownWords: job.ownInput,
        // The chat wrote the first message for the user (propose_actions): their request, not a paste.
        byChat: ctx.thread.chatAuthored && job.idx === 0,
        revision: job.revising.length > 0,
      });
      const snapshot: ItemSnapshot = {
        ...(yield* retrieval.snapshot({
          // Typed input from before the message box keeps its « and » as plain quotes (D56).
          quote: source === "typed" && !ctx.thread.firstInline ? plainQuotes(job.quote) : job.quote,
          source,
          senderPersonId: ctx.senderPersonId,
          references,
          today: ctx.today,
          ...(job.askedOn ? { askedOn: job.askedOn } : {}),
          thread,
          exclude,
          revokedHere: ctx.thread.revokedKeys,
          // The work block (D61 Reads): what the item itself names, and whose words it is.
          ownKeys: own.issueKeys.filter((k) => !deleted.has(k)),
          ownInput: job.ownInput,
          inboxItemId,
          createdKeys: ctx.thread.createdKeys,
        })),
        ownInput: job.ownInput,
        ...(threadCreates.length ? { threadCreates } : {}),
      };
      return { inboxItemId, job, snapshot, eventOf, keys: references.issueKeys };
    });
  type PreparedItem = Effect.Effect.Success<ReturnType<typeof prepareItem>>;

  /** The item's one schema-bound model call and validation (D68: retried by the Llm). */
  const decideItem = (
    { inboxItemId, job, snapshot, eventOf }: PreparedItem,
    ctl: Ctl,
    pos: number,
  ) =>
    Effect.gen(function* () {
      const result = yield* Effect.either(
        llm.object<ItemOutput>("classify_item", {
          schema: buildItemSchema(snapshot) as never,
          ...buildClassifyPrompt(snapshot),
          validate: (out) => validateItemOutput(out, snapshot),
          confidence: (out) => out.confidence,
          ...(ctl.tier ? { tier: ctl.tier } : {}),
          hooks: hooksOf(ctl, pos),
        }),
      );
      const itemId = newId();
      const row = {
        id: itemId,
        inboxItemId,
        idx: job.idx,
        quote: job.quote,
        snapshot,
        promptVersion: snapshot.promptVersion,
      };
      if (Either.isLeft(result)) {
        const error = result.left;
        // Provider problems fail the item; the message is kept for a retry.
        if (error.kind !== "schema") return yield* error;
        return {
          itemId,
          // Written with the item's cards, so a stop never leaves it alone (D68).
          row: { ...row, error: [error.message, ...(error.issues ?? [])].join("\n") },
          mapped: [],
          question: `${FAILED_QUESTION}: "${job.quote.slice(0, 200)}". What should happen?`,
          summary: null,
          event: eventOf(itemId),
        } satisfies Classified;
      }
      const { value, tier, model, escalated, lowConfidence } = result.right;
      // Ask when the model asks, or when it is unsure and has nothing to propose.
      // Low-confidence proposals stay and show their confidence in review.
      const question =
        value.question?.trim() ||
        (lowConfidence && value.proposals.length === 0 ? UNSURE_QUESTION : null);
      return {
        itemId,
        row: {
          ...row,
          summary: value.summary,
          output: value,
          tier,
          model,
          escalated,
          lowConfidence,
        },
        mapped: mapItemOutput(value, job.quote, snapshot),
        question,
        summary: value.summary,
        event: eventOf(itemId),
      } satisfies Classified;
    });

  /** The work event an item becomes (D61), attached later by the pass. */
  const eventRow = (inboxItemId: string, { event: { at, ...data }, summary }: Classified) => ({
    kind: "message" as const,
    at,
    // Only the user's own words and their chat requests are by "me"; a paste is
    // by its sender, or by someone unknown (D61): never the user's promise.
    actor: (data.ownWords || data.byChat
      ? "me"
      : data.senderPersonId
        ? `contact:${data.senderPersonId}`
        : "unknown") as Actor,
    ref: data.intakeItemId,
    // Never the pasted words themselves: a summary is shown outside the untrusted block.
    summary: (
      summary ??
      (data.ownWords
        ? "Your message"
        : data.byChat
          ? "Your request in the chat"
          : data.senderPersonId
            ? "A message from a contact"
            : "A pasted message")
    )
      .replace(/\s+/g, " ")
      .slice(0, 200),
    data: { ...data, inboxItemId } satisfies MessageData,
  });

  /**
   * Writes one assistant turn item by item (D22, D68): each decided item's
   * proposals and question are stored as it finishes, under the turn's one
   * answer. `$new` refs are numbered across the turn's items around the refs the
   * thread keeps, and a create an earlier item made stands for a later item's
   * equal one: merging the items so far gives the earlier items the refs they
   * already have, so the turn ends with the proposals the end-of-turn merge gave.
   * The thread's `triage` holds the turn while it runs (`RunRecord`), so a stop or
   * a failure keeps what was written and a resume reads only the items left.
   */
  const turnWriter = (
    thread: Thread,
    opts: {
      kind: RunRecord["kind"];
      /** Every proposal the turn replaces, and those of each revised item. */
      supersede: readonly ProposalRow[];
      supersedeByIdx: ReadonlyMap<number, readonly ProposalRow[]>;
      instruction: string | null;
      quotes: readonly string[];
      messageId: string | null;
      source: string;
      /** The turn this one resumes: its answer, counts and what it wrote. */
      resumed?: RunRecord | null;
    },
  ) => {
    const inboxItemId = thread.item.id;
    const superseded = new Set(opts.supersede.map((r) => r.id));
    // New refs must not collide with creates that stay in the thread.
    const reserved = new Set(
      thread.rows
        .filter((r) => r.status !== "superseded" && !superseded.has(r.id))
        .map(effectivePayload)
        .flatMap((p) => ownRef(p) ?? []),
    );
    // Playbooks (Phase 26): a wait or a resolved wait brings its chores, as one bundle.
    // What the thread dropped: classify's own proposals rejected, or replaced by a
    // revision (now or before), and a playbook's chores the user left out.
    const chore = (r: { bundleId: string | null; id: string }) =>
      !!r.bundleId && r.bundleId !== r.id;
    const dropped = [
      ...thread.rows.filter(
        (r) => r.status === "rejected" || (r.status === "superseded" && !chore(r)),
      ),
      ...opts.supersede.filter((r) => !chore(r)),
    ].map(effectivePayload);
    const prior = opts.resumed ?? null;
    const turnId = prior?.id || newId();
    // A resumed turn's items collapse into what it wrote before the stop (D68).
    const seed = prior?.assistantMessageId
      ? thread.rows
          .filter(
            (r) =>
              r.messageId === prior.assistantMessageId &&
              r.kind !== "needs_clarification" &&
              !chore(r) &&
              r.status !== "superseded" &&
              r.status !== "rejected",
          )
          .map(effectivePayload)
      : [];
    const merge = (items: readonly Classified[]) =>
      mergeItemProposals(
        items.map((r) => r.mapped),
        reserved,
        seed,
      );
    const results: Classified[] = [];
    // The row each turn proposal was written as, by item and payload.
    const origins = new Map<
      string,
      { id: string; rationale: string; evidence: string; confidence: number }
    >();
    const written: {
      id: string;
      seq: number;
      item: number;
      bundleId: string | null;
      payload: ProposalPayload;
    }[] = [];
    const records = new Map<string, SituationRecord>();
    let assistantMessageId = prior?.assistantMessageId ?? null;
    const priorSummary =
      (
        thread.messages.find((m) => m.id === assistantMessageId)?.content as {
          summary?: string | null;
        } | null
      )?.summary ?? null;
    let seq = Math.max(-1, ...thread.rows.map((r) => r.seq)) + 1;
    let undecided: StoredJob[] = [];
    const failed = new Set<number>();
    let decided = prior?.decided ?? 0;
    let cards = prior?.cards ?? 0;
    const itemIds = [...(prior?.itemIds ?? [])];
    const replaced = [...(prior?.replaced ?? [])];
    const keyOf = (m: { itemIndex: number; payload: ProposalPayload }) =>
      `${m.itemIndex}|${JSON.stringify(m.payload)}`;

    const recordOf = (state: RunRecord["state"]): RunRecord => ({
      id: turnId,
      state,
      kind: opts.kind,
      messageId: opts.messageId,
      assistantMessageId,
      instruction: opts.instruction,
      source: opts.source,
      undecided,
      failed: [...failed].sort((a, b) => a - b),
      decided,
      cards,
      itemIds,
      replaced,
      at: nowIso(),
    });
    const currentTriage = q((d) =>
      d
        .select({ triage: inboxItems.triage })
        .from(inboxItems)
        .where(eq(inboxItems.id, inboxItemId))
        .get(),
    ).pipe(Effect.map((r) => r?.triage ?? null));
    /**
     * Writes the turn's record. Its items not read go to `unread` once it stops
     * or fails (and while a resume of it runs), beside other turns' (D68).
     */
    const save = (
      state: RunRecord["state"],
      error?: string,
      item?: { status: "triaged"; summary: string | null },
    ) =>
      Effect.gen(function* () {
        const current = yield* currentTriage;
        const record = recordOf(state);
        const unread = unreadWith(current, turnId, state === "running" && !prior ? null : record);
        yield* q((d) =>
          d
            .update(inboxItems)
            .set({
              ...(item ?? {}),
              triage: { run: record, unread, ...(error ? { error } : {}), at: nowIso() },
            })
            .where(eq(inboxItems.id, inboxItemId)),
        );
      });
    const summaries = () => [
      ...(priorSummary ? [priorSummary] : []),
      ...results.map((r) => r.summary).filter((s): s is string => !!s),
    ];
    /** The thread's status and title as the turn stands. */
    const itemState = () => {
      const questions = results.filter((r) => r.question).length;
      const placeholder = !thread.item.summary || thread.item.summary === "Needs clarification";
      const first =
        summaries().join("; ") ||
        (questions ? "Needs clarification" : (thread.item.summary ?? "Nothing to do"));
      return { status: "triaged" as const, summary: placeholder ? first : thread.item.summary };
    };
    /** The turn's one answer: made with its first item, its summary grows with each. */
    const answer = (now: string) =>
      Effect.gen(function* () {
        const content = { summary: summaries().join("; ") || null };
        const existing = assistantMessageId;
        if (existing) {
          yield* q((d) =>
            d.update(inboxMessages).set({ content }).where(eq(inboxMessages.id, existing)),
          );
          return existing;
        }
        const id = newId();
        yield* q((d) =>
          d.insert(inboxMessages).values({
            id,
            inboxItemId,
            seq: Math.max(-1, ...thread.messages.map((m) => m.seq)) + 1,
            role: "assistant",
            content,
            createdAt: now,
          }),
        );
        assistantMessageId = id;
        return id;
      });

    /**
     * A chore an earlier item's playbook added that this item proposes itself is
     * dropped, as the turn's own proposals drop it when expanded together.
     */
    const dropRepeatedChores = (k: number, fresh: readonly { payload: ProposalPayload }[]) =>
      Effect.gen(function* () {
        const avoid = new Set(
          fresh.flatMap(({ payload: p }) =>
            CHORE_KINDS.includes(p.kind) ? choreTargets(p).map((t) => `${p.kind}|${t}`) : [],
          ),
        );
        if (!avoid.size) return;
        const gone = written.filter((w) => {
          if (w.item >= k || !w.bundleId || w.id === w.bundleId) return false;
          if (!CHORE_KINDS.includes(w.payload.kind)) return false;
          const required = records.get(w.bundleId)?.steps.find((s) => s.seq === w.seq)?.required;
          return (
            !required && choreTargets(w.payload).some((t) => avoid.has(`${w.payload.kind}|${t}`))
          );
        });
        if (!gone.length) return;
        // Only steps still undecided go; one approved meanwhile stays on its card.
        const deleted = new Set(
          (yield* q((d) =>
            d
              .delete(proposals)
              .where(
                and(
                  inArray(
                    proposals.id,
                    gone.map((w) => w.id),
                  ),
                  eq(proposals.status, "pending"),
                ),
              )
              .returning({ id: proposals.id }),
          )).map((r) => r.id),
        );
        const removed = gone.filter((w) => deleted.has(w.id));
        for (const bundleId of new Set(removed.map((w) => w.bundleId ?? ""))) {
          const record = records.get(bundleId);
          if (!record) continue;
          const seqs = new Set(removed.filter((w) => w.bundleId === bundleId).map((w) => w.seq));
          const next = { ...record, steps: record.steps.filter((s) => !seqs.has(s.seq)) };
          // As the turn expanded at once: a bundle down to one step, with nothing
          // found, is its proposal alone.
          if (next.steps.length < 2 && !next.found?.results.length) {
            records.delete(bundleId);
            yield* q((d) =>
              d
                .update(proposals)
                .set({ bundleId: null, bundleKind: null })
                .where(eq(proposals.bundleId, bundleId)),
            );
            yield* q((d) => d.delete(bundles).where(eq(bundles.id, bundleId)));
            for (const w of written) if (w.bundleId === bundleId) w.bundleId = null;
            continue;
          }
          records.set(bundleId, next);
          yield* q((d) => d.update(bundles).set({ record: next }).where(eq(bundles.id, bundleId)));
        }
        for (const w of removed) written.splice(written.indexOf(w), 1);
      });

    /**
     * A stopped or failed revision keeps the old proposals of the items it did
     * not reach; a create among them whose ref an item it did reach now uses is
     * given a free ref, so approving one never stands for the other.
     */
    const untangle = Effect.gen(function* () {
      if (opts.kind !== "revise" || !written.length) return;
      const left = undecided.flatMap((j) => opts.supersedeByIdx.get(j.idx) ?? []);
      const taken = new Set([
        ...reserved,
        ...written.flatMap((w) => ownRef(w.payload) ?? []),
        ...left.flatMap((r) => ownRef(effectivePayload(r)) ?? []),
      ]);
      const used = new Set(written.flatMap((w) => ownRef(w.payload) ?? []));
      const renames = new Map<string, string>();
      for (const r of left) {
        const own = ownRef(effectivePayload(r));
        if (!own || !used.has(own) || renames.has(own)) continue;
        const ns = own.slice(0, own.indexOf(":"));
        let n = 1;
        while (taken.has(`${ns}:${n}`)) n++;
        taken.add(`${ns}:${n}`);
        renames.set(own, `${ns}:${n}`);
      }
      if (!renames.size) return;
      const rename = (p: ProposalPayload): ProposalPayload => {
        const own = ownRef(p);
        const next = resolveRefs(p, renames);
        return own && renames.has(own) && "ref" in next
          ? ({ ...next, ref: renames.get(own) } as ProposalPayload)
          : next;
      };
      for (const r of left) {
        const payload = rename(ProposalPayloadSchema.parse(r.payload));
        const edited = r.editedPayload
          ? rename(ProposalPayloadSchema.parse(r.editedPayload))
          : null;
        yield* q((d) =>
          d
            .update(proposals)
            .set({ payload, ...(edited ? { editedPayload: edited } : {}) })
            .where(and(eq(proposals.id, r.id), eq(proposals.status, "pending"))),
        );
      }
    });

    /** The turn's items, all undecided, as it starts. */
    const begin = (jobs: readonly Placed[]) =>
      Effect.suspend(() => {
        undecided = jobs.map(storedJob);
        return save("running");
      });

    /** Stores what one item decided: its proposals, its question, its work event. */
    const write = (job: Placed, c: Classified) =>
      Effect.gen(function* () {
        const k = results.length;
        const all = merge([...results, c]);
        const fresh = all.filter((m) => m.itemIndex === k);
        const earlier = all.filter((m) => m.itemIndex < k);
        const expanded = yield* expandTurn(fresh, {
          senderPersonId: thread.item.senderPersonId,
          today: localDate(),
          dropped,
          replacing: superseded,
          earlier: earlier.map((m) => m.payload),
        }).pipe(
          withDb,
          Effect.provideService(Settings, settingsSvc),
          Effect.provideService(JiraClient, jira),
        );
        // A stop waits for the item's rows: never half an item.
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            results.push(c);
            const now = nowIso();
            yield* q((d) => d.insert(intakeItems).values(c.row));
            const messageId = yield* answer(now);
            const shown = expanded.proposals;
            const base = seq;
            const rows = [
              ...shown.map((m, i) => ({
                id: m.id,
                inboxItemId,
                intakeItemId: c.itemId,
                messageId,
                seq: base + i,
                kind: m.payload.kind,
                payload: m.payload,
                rationale: m.rationale,
                evidence: m.evidence,
                confidence: m.confidence,
                status: "pending" as const,
                createdAt: now,
                bundleId: m.bundleId,
                bundleKind: m.bundleKind,
              })),
              ...(c.question
                ? [
                    {
                      id: newId(),
                      inboxItemId,
                      intakeItemId: c.itemId,
                      messageId,
                      seq: base + shown.length,
                      kind: "needs_clarification",
                      payload: { kind: "needs_clarification", question: c.question },
                      rationale: null,
                      evidence: null,
                      confidence: null,
                      status: "pending" as const,
                      createdAt: now,
                    },
                  ]
                : []),
            ];
            seq += rows.length;
            if (rows.length) yield* q((d) => d.insert(proposals).values(rows));
            for (const b of expanded.bundles) {
              const record = {
                rule: b.kind,
                key: `${b.kind}:${b.id}`,
                title: b.title,
                why: b.why,
                keys: b.keys,
                waits: b.waits,
                comments: [],
                facts: b.facts,
                itemName: "",
                steps: shown.flatMap((m, i) =>
                  m.bundleId === b.id && m.step ? [{ seq: base + i, ...m.step }] : [],
                ),
                found: b.found,
                origin: b.origin,
              } satisfies SituationRecord;
              records.set(b.id, record);
              yield* q((d) =>
                d
                  .insert(bundles)
                  .values({ id: b.id, inboxItemId, kind: b.kind, createdAt: now, record }),
              );
            }
            // Which rows hold each new proposal: a plain row, or a bundle's first step.
            let g = -1;
            for (const [i, m] of shown.entries()) {
              if (!m.bundleId || m.id === m.bundleId) {
                g++;
                const f = fresh[g];
                if (f)
                  origins.set(keyOf(f), {
                    id: m.id,
                    rationale: m.rationale,
                    evidence: m.evidence,
                    confidence: m.confidence,
                  });
              }
              written.push({
                id: m.id,
                seq: base + i,
                item: k,
                bundleId: m.bundleId,
                payload: m.payload,
              });
            }
            // A proposal of an earlier item this one repeats keeps the more confident reasons.
            for (const m of earlier) {
              const o = origins.get(keyOf(m));
              if (
                !o ||
                (o.confidence === m.confidence &&
                  o.rationale === m.rationale &&
                  o.evidence === m.evidence)
              )
                continue;
              const reasons = {
                rationale: m.rationale,
                evidence: m.evidence,
                confidence: m.confidence,
              };
              origins.set(keyOf(m), { id: o.id, ...reasons });
              yield* q((d) =>
                d
                  .update(proposals)
                  .set(reasons)
                  .where(and(eq(proposals.id, o.id), eq(proposals.status, "pending"))),
              );
            }
            yield* dropRepeatedChores(k, fresh);
            // Each item read or revised is a work event (D61).
            yield* withDb(recordEvents([eventRow(inboxItemId, c)]));
            // Only what is still undecided is replaced: a card approved meanwhile stays.
            const own = (opts.supersedeByIdx.get(job.idx) ?? []).map((r) => r.id);
            if (own.length) {
              const done = yield* q((d) =>
                d
                  .update(proposals)
                  .set({ status: "superseded", decidedAt: now })
                  .where(and(inArray(proposals.id, own), eq(proposals.status, "pending")))
                  .returning({ id: proposals.id }),
              );
              replaced.push(...done.map((r) => r.id));
            }
            undecided = undecided.filter((u) => u.pos !== job.pos);
            failed.delete(job.pos);
            decided++;
            cards += shown.length;
            itemIds.push(c.itemId);
            yield* save("running", undefined, itemState());
            return { cards: shown.length, questions: c.question ? 1 : 0, messageId };
          }),
        );
      });

    /** The item's calls failed after their retries: it stays undecided. */
    const failItem = (job: Placed) => Effect.sync(() => failed.add(job.pos));

    /** The turn ends with every item decided: its counts replace the record. */
    const finish = (ctl: Ctl) =>
      Effect.gen(function* () {
        step(ctl, "write", "start", "Writing the answer");
        const now = nowIso();
        // Every turn answers, even with nothing to do.
        if (!assistantMessageId) yield* answer(now);
        const merged = merge(results);
        const questions = results.filter((r) => r.question).length;
        // FR-7.2: a requested change is a correction worth learning from.
        // The sprint switch is code's field, so it is no part of the example (D57).
        // A playbook's chores are code's, not part of what the user asked to change.
        // A turn that stopped part way and was resumed records none.
        const before = opts.supersede
          .filter((r) => r.kind !== "needs_clarification" && !chore(r))
          .map((r) => withoutCodeFields(effectivePayload(r)));
        if (!prior && opts.instruction && before.length) {
          const after = merged.map((m) => withoutCodeFields(m.payload));
          const instruction = opts.instruction;
          yield* q((d) =>
            d.insert(memories).values({
              id: newId(),
              kind: "example",
              subjectType: "revision",
              content: `Asked "${instruction}": ${before.map(describePayload).join("; ")} -> ${after.map(describePayload).join("; ") || "nothing"}`,
              // Only the instruction's «...» values are markers; the input's are plain quotes.
              exampleInput:
                `${opts.quotes.map(plainQuotes).join("\n")}\nThe user asked: ${instruction}`.slice(
                  0,
                  1000,
                ),
              exampleBefore: before,
              exampleAfter: after,
              source: "user",
              sourceInboxItemId: inboxItemId,
              confirmed: true,
              createdAt: now,
            }),
          );
        }
        const current = yield* currentTriage;
        yield* q((d) =>
          d
            .update(inboxItems)
            .set({
              ...itemState(),
              triage: {
                items: results.length,
                proposals: merged.length,
                questions,
                // Other turns' items not read stay for their Resume (D68).
                unread: unreadWith(current, turnId, null),
                // What Edit takes back of this turn while its cards are undecided (D68).
                turn: { messageId: opts.messageId, itemIds, replaced },
                at: now,
              },
            })
            .where(eq(inboxItems.id, inboxItemId)),
        );
        step(ctl, "write", "end", "Wrote the answer");
        logger.info(
          `Turn ${inboxItemId}: ${results.length} items, ${merged.length} proposals, ${questions} questions, ${replaced.length} replaced`,
        );
        return {
          inboxItemId,
          items: results.length,
          proposals: merged.length,
          questions,
        } satisfies TriageResult;
      });

    return {
      begin,
      write,
      failItem,
      finish,
      /** Calls failed after their retries: the record says which items are left. */
      fail: (error: { message: string }) =>
        Effect.zipRight(untangle, save("failed", error.message)),
      /** The user stopped the turn: what was written stays. */
      stop: Effect.zipRight(untangle, save("stopped")).pipe(Effect.ignore),
    };
  };
  type TurnWriter = ReturnType<typeof turnWriter>;

  /**
   * Reads a turn's items (D68): the lookups for all of them first, then each
   * item's model call, its cards written as soon as it is decided. An item whose
   * calls fail after their retries (time, server, rate limit) fails alone and the
   * next is read; any other failure leaves the rest undecided. A stop keeps what
   * was written.
   */
  const runTurn = (writer: TurnWriter, jobs: readonly Job[], ctx: Ctx, ctl: Ctl, verb: string) =>
    Effect.gen(function* () {
      const placed: Placed[] = jobs.map((j, i) => ({
        ...j,
        pos: j.pos ?? i,
        count: j.count ?? jobs.length,
      }));
      yield* writer.begin(placed);
      let failure: LlmError | null = null;
      if (placed.length) {
        const count = placed[0]?.count ?? placed.length;
        step(ctl, "lookup", "start", "Looking up tickets, people and your work", { count });
        const prepared = yield* Effect.forEach(placed, (job) =>
          Effect.map(prepareItem(ctx.thread.item.id, job, ctx), (p) => ({ ...p, job })),
        );
        const keys = [...new Set(prepared.flatMap((p) => p.keys))];
        step(ctl, "lookup", "end", "Looked up tickets, people and your work", {
          count,
          ...(keys.length
            ? { detail: keys.slice(0, 3).join(", ") + (keys.length > 3 ? ", …" : "") }
            : {}),
        });
        for (const p of prepared) {
          const { pos, count } = p.job;
          const title = count > 1 ? `${verb} item ${pos + 1} of ${count}` : verb;
          const at = { item: pos, count };
          step(ctl, "decide", "start", title, { ...at, detail: excerpt(p.job.quote) });
          const r = yield* Effect.either(decideItem(p, ctl, pos));
          if (Either.isLeft(r)) {
            const e = r.left;
            ctl.emit({
              type: "item_failed",
              at: Date.now(),
              ...at,
              message: e.message,
              kind: e._tag === "LlmError" ? e.kind : e._tag,
            });
            yield* writer.failItem(p.job);
            if (e._tag !== "LlmError") return yield* e;
            failure ??= e;
            // Time, server and rate limits may pass; other failures hold for every item.
            if (!RETRYABLE_KINDS.includes(e.kind)) break;
            continue;
          }
          const w = yield* writer.write(p.job, r.right);
          step(ctl, "decide", "end", title, at);
          ctl.emit({
            type: "item_done",
            at: Date.now(),
            ...at,
            cards: w.cards,
            questions: w.questions,
            assistantMessageId: w.messageId,
          });
        }
      }
      if (failure) {
        yield* writer.fail(failure);
        return yield* failure;
      }
      return yield* writer.finish(ctl);
    }).pipe(
      Effect.onInterrupt(() => writer.stop),
      Effect.tapErrorTag("DbError", (e) => writer.fail(e).pipe(Effect.ignore)),
    );

  /**
   * A failed turn keeps its message; the error shows until a retry succeeds. A
   * turn that wrote part of its items keeps its record (D68) with the error.
   */
  const recordFailure = <A, E extends { message: string }, R>(
    inboxItemId: string,
    effect: Effect.Effect<A, E, R>,
  ) =>
    effect.pipe(
      Effect.tapError((e) =>
        Effect.gen(function* () {
          const item = yield* q((d) =>
            d
              .select({ triage: inboxItems.triage })
              .from(inboxItems)
              .where(eq(inboxItems.id, inboxItemId))
              .get(),
          );
          const run = runRecordOf(item?.triage);
          const unread = unreadOf(item?.triage);
          yield* q((d) =>
            d
              .update(inboxItems)
              .set({
                triage: {
                  ...(run ? { run } : {}),
                  ...(unread.length ? { unread } : {}),
                  error: e.message,
                  at: nowIso(),
                },
              })
              .where(eq(inboxItems.id, inboxItemId)),
          );
        }).pipe(Effect.ignore),
      ),
    );

  const ctxOf = (thread: Thread, today?: string, source?: string): Ctx => ({
    thread,
    source: source ?? thread.item.source,
    senderPersonId: thread.item.senderPersonId,
    today: today ?? localDate(),
  });

  /**
   * The thread's first input is the user's own words: typed, not pasted, not
   * the chat's (D55); or a block of their daily note that quotes no one (D65).
   */
  const typedByUser = (thread: Thread) =>
    (thread.item.source === "typed" && !thread.chatAuthored) ||
    (thread.item.source === "note" && !thread.firstPasted);

  /** The first turn: split the input and classify every item with the instruction sent with it. */
  const runFirst = (inboxItemId: string, today: string | undefined, ctl: Ctl) =>
    Effect.gen(function* () {
      const thread = yield* loadThread(inboxItemId);
      const cleaned = cleanInput(thread.item.rawText) || thread.item.rawText.trim();
      const quotes = yield* segment(cleaned, thread.item.source, ctl);
      const ownInput = typedByUser(thread);
      const jobs = quotes.map((quote, idx) => ({
        idx,
        quote,
        instructions: thread.instructions,
        revising: [],
        ownInput,
      }));
      const writer = turnWriter(thread, {
        kind: "read",
        supersede: [],
        supersedeByIdx: new Map(),
        instruction: null,
        quotes,
        messageId: thread.messages.find((m) => m.role === "user")?.id ?? null,
        source: thread.item.source,
      });
      return yield* runTurn(writer, jobs, ctxOf(thread, today), ctl, "Deciding");
    });

  /** Items a typed follow-up is about (D22). */
  const route = (thread: Thread, instruction: string, answers: string | null, ctl: Ctl) =>
    Effect.gen(function* () {
      const indices = [...thread.current.keys()].sort((a, b) => a - b);
      const question = answers ? thread.rows.find((r) => r.id === answers) : undefined;
      const asked = question?.intakeItemId ? thread.idxOf.get(question.intakeItemId) : undefined;
      if (asked !== undefined) return [asked];
      if (indices.length <= 1) return indices;
      step(ctl, "route", "start", "Working out what this is about");
      const items = indices.map((idx) => ({
        quote: thread.current.get(idx)?.quote ?? "",
        proposals: (thread.pendingByIdx.get(idx) ?? [])
          .filter((r) => r.kind !== "needs_clarification")
          .map((r) => describePayload(effectivePayload(r))),
      }));
      const chosen = yield* llm
        .object<RouteReplyOutput>("route_reply", {
          schema: buildRouteReplySchema(items.length) as never,
          ...buildRouteReplyPrompt(items, instruction),
          validate: validateRouteReply,
          ...(ctl.tier ? { tier: ctl.tier } : {}),
          hooks: hooksOf(ctl),
        })
        .pipe(
          Effect.map((r) =>
            r.value.items
              .map((n) => indices[Number(n) - 1])
              .filter((i): i is number => i !== undefined),
          ),
          // When routing cannot be trusted, revise every item.
          Effect.catchIf(
            (e) => e.kind === "schema",
            () => Effect.succeed(indices),
          ),
        );
      step(ctl, "route", "end", "Worked out what this is about", {
        detail: chosen.length === 1 ? "1 item" : `${chosen.length} items`,
      });
      return chosen;
    });

  /** The jobs that revise these items with the thread's instructions. */
  const reviseJobs = (thread: Thread, affected: readonly number[]) => {
    const replacing = new Set(
      affected.flatMap((idx) => (thread.pendingByIdx.get(idx) ?? []).map((r) => r.id)),
    );
    return affected.map((idx): Job => {
      const own = thread.pendingByIdx.get(idx) ?? [];
      // A create from another item that this item points at comes along, so the
      // model can keep the reference.
      const used = new Set(
        own.map(effectivePayload).flatMap((p) => placeholderRefs(p, { includeOwn: true })),
      );
      const borrowed = affected
        .filter((other) => other !== idx)
        .flatMap((other) => thread.pendingByIdx.get(other) ?? [])
        .filter((r) => {
          const ref = ownRef(effectivePayload(r));
          return !!ref && used.has(ref);
        });
      const snapshot = thread.current.get(idx)?.snapshot as Partial<ItemSnapshot> | null;
      // Each item keeps where its input came from: a paste in a typed thread stays
      // a paste (D55). Older snapshots without the flag fall back to the thread's
      // source for the first item only.
      const first = idx === 0 && typedByUser(thread);
      return {
        idx,
        quote: thread.current.get(idx)?.quote ?? "",
        instructions: thread.instructions,
        revising: [...borrowed, ...own],
        replacing,
        askedOn: snapshot?.askedOn ?? snapshot?.today,
        source: snapshot?.source ?? (idx === 0 ? thread.item.source : "other"),
        ownInput: snapshot?.ownInput ?? first,
        questions: thread.questionsByIdx.get(idx) ?? [],
      };
    });
  };

  const byIdx = (thread: Thread, affected: readonly number[]) =>
    new Map(affected.map((idx) => [idx, thread.pendingByIdx.get(idx) ?? []] as const));

  /** Revises items with the thread's instructions; their undecided proposals are replaced. */
  const revise = (
    thread: Thread,
    chosen: readonly number[],
    opts: { instruction: string | null; today?: string; ctl: Ctl; messageId: string | null },
  ) =>
    Effect.gen(function* () {
      const pendingPayloads = new Map(
        [...thread.pendingByIdx].map(([idx, rows]) => [
          idx,
          rows.filter((r) => r.kind !== "needs_clarification").map(effectivePayload),
        ]),
      );
      const affected = withLinkedItems(chosen, pendingPayloads).filter((idx) =>
        thread.current.has(idx),
      );
      const jobs = reviseJobs(thread, affected);
      const writer = turnWriter(thread, {
        kind: "revise",
        supersede: affected.flatMap((idx) => thread.pendingByIdx.get(idx) ?? []),
        supersedeByIdx: byIdx(thread, affected),
        instruction: opts.instruction,
        quotes: jobs.map((j) => j.quote),
        messageId: opts.messageId,
        source: thread.item.source,
      });
      return yield* runTurn(writer, jobs, ctxOf(thread, opts.today), opts.ctl, "Revising");
    });

  /** Runs the turn for a stored user message. */
  const runReply = (inboxItemId: string, messageId: string, today: string | undefined, ctl: Ctl) =>
    Effect.gen(function* () {
      const thread = yield* loadThread(inboxItemId);
      const message = thread.messages.find((m) => m.id === messageId);
      const content = UserContentSchema.parse(message?.content ?? { parts: [] });
      const asInput = !!content.asInput;
      const { input, instruction } = splitMessage(content.parts, asInput, content.inline);
      if (input) {
        // New input joins the thread as new items, instructed by this message only.
        // Pasted text is never the user's own words, whatever source it was given;
        // a message that is input as a whole (a note block, D66) kept its source
        // when it was stored, and is the user's words when it quotes no one.
        const named = content.source ?? thread.item.source;
        const source = asInput ? named : ownWordsSource(named) ? "other" : named;
        const ownInput =
          asInput && ownWordsSource(named) && !hasInput(content.parts, !!content.inline);
        const cleaned = cleanInput(input) || input.trim();
        const quotes = yield* segment(cleaned, source, ctl);
        const start = Math.max(-1, ...thread.current.keys()) + 1;
        const jobs = quotes.map((quote, i) => ({
          idx: start + i,
          quote,
          instructions: instruction ? [instruction] : [],
          revising: [],
          source,
          ownInput,
        }));
        const writer = turnWriter(thread, {
          kind: "read",
          supersede: [],
          supersedeByIdx: new Map(),
          instruction: null,
          quotes,
          messageId,
          source,
        });
        return yield* runTurn(writer, jobs, ctxOf(thread, today, source), ctl, "Deciding");
      }
      if (thread.current.size === 0) return yield* runFirst(inboxItemId, today, ctl);
      const chosen = yield* route(thread, instruction ?? "", content.answers ?? null, ctl);
      return yield* revise(thread, chosen, { instruction, today, ctl, messageId });
    });

  /** Reads the items a stopped or failed turn left (D68), continuing its answer. */
  const resumeTurn = (thread: Thread, record: RunRecord, ctl: Ctl) =>
    Effect.gen(function* () {
      const where = new Map(record.undecided.map((j) => [j.idx, j] as const));
      const jobs: Job[] =
        record.kind === "read"
          ? record.undecided.map((j) => ({
              idx: j.idx,
              quote: j.quote,
              instructions: j.instructions,
              revising: [],
              ...(j.source ? { source: j.source } : {}),
              ownInput: j.ownInput,
              pos: j.pos,
              count: j.count,
            }))
          : reviseJobs(
              thread,
              record.undecided.map((j) => j.idx).filter((idx) => thread.current.has(idx)),
            ).map((j) => ({
              ...j,
              pos: where.get(j.idx)?.pos ?? 0,
              count: where.get(j.idx)?.count ?? record.undecided.length,
            }));
      const idxs = jobs.map((j) => j.idx);
      const supersedeByIdx = record.kind === "revise" ? byIdx(thread, idxs) : new Map();
      const writer = turnWriter(thread, {
        kind: record.kind,
        supersede: [...supersedeByIdx.values()].flat(),
        supersedeByIdx,
        instruction: record.instruction,
        quotes: jobs.map((j) => j.quote),
        messageId: record.messageId,
        source: record.source,
        resumed: record,
      });
      return yield* runTurn(
        writer,
        jobs,
        ctxOf(thread, undefined, record.source),
        ctl,
        record.kind === "read" ? "Deciding" : "Revising",
      );
    });

  const triage = (input: TriageInput) =>
    Effect.gen(function* () {
      const ctl = controlOf(input);
      // From the message box (D56): a paste that is a value inside a line is not input.
      const parts = input.parts ? mergeParts(input.parts) : null;
      const split = parts ? splitMessage(parts, true, true) : null;
      const typed = parts ? !hasInput(parts, true) : input.source === "typed";
      const text = split ? split.input : (input.text ?? "");
      // Pasted input is never the user's own words (D55): "typed" given with a paste is "other".
      // A daily note block stays "note" (D65); a ">" quote in it is its pasted input.
      const note = input.source === "note";
      const source: Source = note
        ? "note"
        : typed
          ? "typed"
          : input.source === "typed"
            ? "other"
            : input.source;
      if (!text.trim())
        return yield* new IntakeError({ kind: "empty", message: "Paste or type something first." });
      const inboxItemId = newId();
      const messageId = newId();
      const now = nowIso();
      // The thread, its message and the event saying so go together: an Edit
      // right after Send always knows the message to take back (D68).
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* q((d) =>
            d.insert(inboxItems).values({
              id: inboxItemId,
              source,
              senderPersonId: typed && parts ? null : input.senderPersonId,
              rawText: text,
              receivedAt: now,
              status: "new",
            }),
          );
          yield* q((d) =>
            d.insert(inboxMessages).values({
              id: messageId,
              inboxItemId,
              seq: 0,
              role: "user",
              content: {
                ...(parts
                  ? { parts, inline: true }
                  : { parts: partsOf(text, input.instruction ?? null, typed) }),
                source,
                ...(input.author ? { author: input.author } : {}),
                ...(note && input.noteDate ? { noteDate: input.noteDate } : {}),
              },
              createdAt: now,
            }),
          );
          // The message is in its thread at once (FR-21.1).
          ctl.emit({ type: "stored", at: Date.now(), inboxItemId, messageId });
        }),
      );
      return yield* recordFailure(inboxItemId, runFirst(inboxItemId, input.today, ctl));
    });

  /** Threads a feature started (planner, rule suggestions) have no input to classify again. */
  const refuseFeatureThread = (thread: Thread) => {
    const first = thread.messages.find((m) => m.role === "user");
    const origin = UserContentSchema.safeParse(first?.content).data?.origin;
    if (!origin) return Effect.void;
    return Effect.fail(
      new IntakeError({
        kind: "read_only",
        message:
          origin === "planner"
            ? "This thread holds a sprint plan. Change the plan in Sprint > Plan."
            : "This thread holds suggested rules. Approve or reject them here, or edit rules in Context > Memory.",
      }),
    );
  };

  const reply = (input: ReplyInput) =>
    Effect.gen(function* () {
      const ctl = controlOf(input);
      const parts = input.parts ? mergeParts(input.parts) : null;
      // New input as a whole (D66): typed parts are input, as in a first message.
      const asInput = !!input.asInput && !!parts;
      const split = parts ? splitMessage(parts, asInput, true) : null;
      const text = split ? split.input : (input.text?.trim() ?? "");
      const instruction = split ? split.instruction : input.instruction?.trim() || null;
      if (!text && !instruction)
        return yield* new IntakeError({ kind: "empty", message: "Type or paste something first." });
      const thread = yield* loadThread(input.inboxItemId);
      yield* refuseFeatureThread(thread);
      // A work model question's answer goes to the work model, not to classify (D61).
      const asked = input.answers ? thread.rows.find((r) => r.id === input.answers) : undefined;
      const workAnswer =
        asked?.status === "pending" && (asked.payload as { work?: unknown }).work && !text
          ? asked
          : null;
      if (thread.item.workItemId && !workAnswer)
        return yield* new IntakeError({
          kind: "read_only",
          message:
            "This thread holds questions about a work item. Answer one of them here; to tell me something new, start a new message in the Inbox.",
        });
      // Pasted text is never "typed": only the user's own words state points without
      // a cue (D55 answers), so a paste that would be "typed" is "other".
      const named = input.source ?? (thread.item.source as Source);
      // As input, a note block stays "note" (its ">" quote is its pasted input),
      // as in `triage`; typed words alone are "typed", a paste is never "typed".
      const typedOnly = !!parts && !hasInput(parts, true);
      const replySource: Source = asInput
        ? named === "note"
          ? "note"
          : typedOnly
            ? "typed"
            : named === "typed"
              ? "other"
              : named
        : text && ownWordsSource(named)
          ? "other"
          : named;
      const now = nowIso();
      const messageId = newId();
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          yield* q((d) =>
            d.insert(inboxMessages).values({
              id: messageId,
              inboxItemId: input.inboxItemId,
              seq: Math.max(-1, ...thread.messages.map((m) => m.seq)) + 1,
              role: "user",
              content: {
                parts: parts ?? partsOf(text, instruction, false),
                ...(parts ? { inline: true } : {}),
                source: replySource,
                answers: input.answers ?? null,
                ...(asInput ? { asInput: true } : {}),
                ...(asInput && replySource === "note" && input.noteDate
                  ? { noteDate: input.noteDate }
                  : {}),
              },
              createdAt: now,
            }),
          );
          ctl.emit({ type: "stored", at: Date.now(), inboxItemId: input.inboxItemId, messageId });
        }),
      );
      // A reply in a parked thread takes it up: it is back, saying so (D62).
      yield* withDb(takeUp(input.inboxItemId, "replied"));
      if (input.answers) {
        yield* q((d) =>
          d
            .update(proposals)
            .set({ status: "executed", decidedAt: now, result: { answer: instruction ?? text } })
            .where(
              and(
                eq(proposals.id, input.answers ?? ""),
                eq(proposals.inboxItemId, input.inboxItemId),
                eq(proposals.status, "pending"),
              ),
            ),
        );
      }
      // A work model question's answer goes to the work model, not to classify (D61).
      if (workAnswer) {
        const answer = yield* withDb(answerWorkQuestion(workAnswer, instruction ?? ""));
        if (!answer.reask) yield* withDb(postMessage(input.inboxItemId, answer.message));
        const open = yield* q((d) =>
          d
            .select({ id: proposals.id })
            .from(proposals)
            .where(
              and(eq(proposals.inboxItemId, input.inboxItemId), eq(proposals.status, "pending")),
            )
            .all(),
        );
        if (open.length === 0)
          yield* q((d) =>
            d
              .update(inboxItems)
              .set({ status: "filed" })
              .where(eq(inboxItems.id, input.inboxItemId)),
          );
        return {
          inboxItemId: input.inboxItemId,
          items: 0,
          proposals: 0,
          questions: answer.reask ? 1 : 0,
        } satisfies TriageResult;
      }
      return yield* recordFailure(
        input.inboxItemId,
        runReply(input.inboxItemId, messageId, input.today, ctl),
      );
    });

  const retriage = (inboxItemId: string, control?: TurnControl) =>
    recordFailure(
      inboxItemId,
      Effect.gen(function* () {
        const ctl = controlOf(control);
        const thread = yield* loadThread(inboxItemId);
        yield* refuseFeatureThread(thread);
        // A work item's thread holds the secretary's questions, no input to read again (D61).
        if (thread.item.workItemId)
          return yield* new IntakeError({
            kind: "read_only",
            message:
              "This thread holds questions about a work item; there is nothing to read again.",
          });
        // Reading it again takes a parked thread up (D62).
        yield* withDb(takeUp(inboxItemId, "replied"));
        // A turn that stopped or failed part way reads the items it left (D68).
        const unread = unreadOf(thread.item.triage);
        const record =
          (control?.messageId !== undefined
            ? unread.find((r) => r.messageId === control.messageId)
            : undefined) ?? unread[0];
        if (record?.undecided.length) {
          ctl.emit({ type: "stored", at: Date.now(), inboxItemId, messageId: record.messageId });
          return yield* resumeTurn(thread, record, ctl);
        }
        const last = thread.messages.at(-1);
        const firstUser = thread.messages.find((m) => m.role === "user");
        // An unanswered message (the last turn failed) is simply run again.
        if (last?.role === "user") {
          ctl.emit({ type: "stored", at: Date.now(), inboxItemId, messageId: last.id });
          if (last.id !== firstUser?.id)
            return yield* runReply(inboxItemId, last.id, undefined, ctl);
        } else ctl.emit({ type: "stored", at: Date.now(), inboxItemId, messageId: null });
        if (thread.current.size === 0) return yield* runFirst(inboxItemId, undefined, ctl);
        return yield* revise(thread, [...thread.current.keys()], {
          instruction: null,
          ctl,
          messageId: null,
        });
      }),
    );

  /** Edit (D68): the message goes, with what its turn wrote, and a thread it was all of. */
  const withdraw = (messageId: string) =>
    Effect.gen(function* () {
      const message = yield* q((d) =>
        d.select().from(inboxMessages).where(eq(inboxMessages.id, messageId)).get(),
      );
      if (message?.role !== "user")
        return yield* new IntakeError({ kind: "not_found", message: "That message is gone." });
      const inboxItemId = message.inboxItemId;
      const thread = yield* loadThread(inboxItemId);
      const later = thread.messages.filter((m) => m.seq > message.seq);
      if (later.some((m) => m.role === "user"))
        return yield* new IntakeError({
          kind: "read_only",
          message: "Only the newest message can be taken back.",
        });
      const answers = new Set(later.map((m) => m.id));
      const rows = thread.rows.filter((r) => r.messageId && answers.has(r.messageId));
      if (rows.some((r) => r.status !== "pending" && r.status !== "superseded"))
        return yield* new IntakeError({
          kind: "decided",
          message: "A card from this message was already approved or rejected, so it stays.",
        });
      const record = lastTurnOf(thread.item.triage);
      const mine = record && record.messageId === messageId ? record : null;
      const content = UserContentSchema.safeParse(message.content).data;
      const itemIds = [
        ...new Set([
          ...(mine?.itemIds ?? []),
          ...rows.flatMap((r) => (r.intakeItemId ? [r.intakeItemId] : [])),
        ]),
      ];
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const ids = rows.map((r) => r.id);
          const bundleIds = [...new Set(rows.flatMap((r) => (r.bundleId ? [r.bundleId] : [])))];
          if (ids.length) yield* q((d) => d.delete(proposals).where(inArray(proposals.id, ids)));
          if (bundleIds.length)
            yield* q((d) => d.delete(bundles).where(inArray(bundles.id, bundleIds)));
          if (itemIds.length) {
            yield* q((d) => d.delete(workEvents).where(inArray(workEvents.ref, itemIds)));
            yield* q((d) => d.delete(proposals).where(inArray(proposals.intakeItemId, itemIds)));
            yield* q((d) => d.delete(intakeItems).where(inArray(intakeItems.id, itemIds)));
          }
          // What the turn replaced is undecided again; the question it answered is open.
          // Never a card that ran: only superseded rows and an answered question.
          const back = mine?.replaced ?? [];
          if (back.length)
            yield* q((d) =>
              d
                .update(proposals)
                .set({ status: "pending", decidedAt: null })
                .where(
                  and(
                    inArray(proposals.id, back),
                    eq(proposals.inboxItemId, inboxItemId),
                    eq(proposals.status, "superseded"),
                  ),
                ),
            );
          const answered = content?.answers;
          if (answered)
            yield* q((d) =>
              d
                .update(proposals)
                .set({ status: "pending", decidedAt: null, result: null })
                .where(
                  and(
                    eq(proposals.id, answered),
                    eq(proposals.inboxItemId, inboxItemId),
                    eq(proposals.status, "executed"),
                    eq(proposals.kind, "needs_clarification"),
                  ),
                ),
            );
          yield* q((d) =>
            d.delete(inboxMessages).where(inArray(inboxMessages.id, [messageId, ...answers])),
          );
          const left = thread.messages.filter((m) => m.id !== messageId && !answers.has(m.id));
          if (left.length === 0) {
            yield* q((d) => d.delete(intakeItems).where(eq(intakeItems.inboxItemId, inboxItemId)));
            yield* q((d) => d.delete(inboxItems).where(eq(inboxItems.id, inboxItemId)));
          } else {
            // Its items not read go with it; other turns' stay for their Resume.
            const unread = unreadOf(thread.item.triage).filter((r) => r.messageId !== messageId);
            const run = runRecordOf(thread.item.triage);
            const keep = run && run.messageId !== messageId ? { run } : {};
            yield* q((d) =>
              d
                .update(inboxItems)
                .set({
                  triage:
                    unread.length || "run" in keep
                      ? { ...keep, ...(unread.length ? { unread } : {}), at: nowIso() }
                      : null,
                })
                .where(eq(inboxItems.id, inboxItemId)),
            );
          }
        }),
      );
      logger.info(`Withdrew message ${messageId} of ${inboxItemId}`);
      return {
        inboxItemId,
        thread: thread.messages.every((m) => m.id === messageId || answers.has(m.id)),
      } satisfies Withdrawn;
    });

  /** Turns in flight when the app quit are stopped turns now (D68). */
  const recoverRuns = Effect.gen(function* () {
    const rows = yield* q((d) =>
      d
        .select({ id: inboxItems.id, triage: inboxItems.triage })
        .from(inboxItems)
        .where(sql`json_extract(${inboxItems.triage}, '$.run.state') = 'running'`)
        .all(),
    );
    for (const r of rows) {
      const run = runRecordOf(r.triage);
      if (!run) continue;
      const stopped = { ...run, state: "stopped" as const };
      yield* q((d) =>
        d
          .update(inboxItems)
          .set({
            triage: {
              ...(r.triage as object),
              run: stopped,
              unread: unreadWith(r.triage, run.id, stopped),
            },
          })
          .where(eq(inboxItems.id, r.id)),
      );
    }
    if (rows.length) logger.info(`${rows.length} turns in flight at quit are stopped`);
    return rows.length;
  });

  return Intake.of({
    triage,
    reply,
    retriage,
    resume: retriage,
    withdraw,
    recoverRuns,
  });
});

export const IntakeLive = Layer.effect(Intake, make);

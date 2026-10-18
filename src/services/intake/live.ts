import { and, asc, eq, inArray } from "drizzle-orm";
import { Effect, Either, Layer } from "effect";
import {
  inboxItems,
  inboxMessages,
  intakeItems,
  jiraIssues,
  memories,
  people,
  proposals,
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
import { Llm } from "@/services/llm";
import {
  createdIds,
  describePayload,
  effectivePayload,
  issueRefs,
  ownRef,
  placeholderRefs,
  resolveRefs,
  withoutCodeFields,
} from "@/services/proposals/schema";
import { Retrieval } from "@/services/retrieval";
import { Settings, settingsOrDefault } from "@/services/settings";
import { Sync } from "@/services/sync";
import { deletedKeys } from "@/services/sync/deleted";
import { EVENT_TEXT_CHARS, recordEvents } from "@/services/work/events";
import { answerWorkQuestion, postMessage } from "@/services/work/questions";
import type { Actor, MessageData } from "@/services/work/schema";
import {
  Intake,
  IntakeError,
  type ReplyInput,
  type Source,
  type TriageInput,
  type TriageResult,
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
type Progress = (message: string) => void;

/** One item to classify in this turn. */
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
};

type Classified = {
  itemId: string;
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
  const segment = (text: string, source: string, progress: Progress) =>
    Effect.gen(function* () {
      if (!needsSegmentation(text)) return [text];
      progress("Splitting into items");
      return yield* llm
        .object<SegmentOutput>("segment_input", {
          schema: SegmentOutputSchema,
          ...buildSegmentPrompt(text, source),
          validate: (out) => validateSegments(out, text),
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
        return splitMessage(c.data.parts, i === 0, c.data.inline).instruction ?? [];
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
      };
    });
  type Thread = Effect.Effect.Success<ReturnType<typeof loadThread>>;
  type Ctx = { thread: Thread; source: string; senderPersonId: string | null; today: string };

  /** How much of each other item in a thread the model sees. */
  const OTHER_QUOTE_CHARS = 600;

  /** Retrieval, one schema-bound model call and validation for one item. */
  const classify = (inboxItemId: string, job: Job, ctx: Ctx) =>
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
      const pending = job.revising.flatMap((r) => {
        if (r.kind === "needs_clarification") return [];
        const shape = fromPayload(resolveRefs(effectivePayload(r), made), local);
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
        })),
        ownInput: job.ownInput,
        ...(threadCreates.length ? { threadCreates } : {}),
      };
      const result = yield* Effect.either(
        llm.object<ItemOutput>("classify_item", {
          schema: buildItemSchema(snapshot) as never,
          ...buildClassifyPrompt(snapshot),
          validate: (out) => validateItemOutput(out, snapshot),
          confidence: (out) => out.confidence,
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
        // Provider problems stop the turn; the message is kept for a retry.
        if (error.kind !== "schema") return yield* error;
        yield* q((d) =>
          d.insert(intakeItems).values({
            ...row,
            error: [error.message, ...(error.issues ?? [])].join("\n"),
          }),
        );
        return {
          itemId,
          mapped: [],
          question: `${FAILED_QUESTION}: "${job.quote.slice(0, 200)}". What should happen?`,
          summary: null,
          event: eventOf(itemId),
        } satisfies Classified;
      }
      const { value, tier, model, escalated, lowConfidence } = result.right;
      yield* q((d) =>
        d.insert(intakeItems).values({
          ...row,
          summary: value.summary,
          output: value,
          tier,
          model,
          escalated,
          lowConfidence,
        }),
      );
      // Ask when the model asks, or when it is unsure and has nothing to propose.
      // Low-confidence proposals stay and show their confidence in review.
      const question =
        value.question?.trim() ||
        (lowConfidence && value.proposals.length === 0 ? UNSURE_QUESTION : null);
      return {
        itemId,
        mapped: mapItemOutput(value, job.quote, snapshot),
        question,
        summary: value.summary,
        event: eventOf(itemId),
      } satisfies Classified;
    });

  const classifyAll = (
    inboxItemId: string,
    jobs: readonly Job[],
    ctx: Ctx,
    progress: Progress,
    verb: string,
  ) =>
    Effect.forEach(jobs, (job, i) => {
      progress(jobs.length > 1 ? `${verb} item ${i + 1} of ${jobs.length}` : verb);
      return classify(inboxItemId, job, ctx);
    });

  /** Stores one assistant turn: its message, proposals and questions (D22). */
  const persistTurn = (
    thread: Thread,
    results: readonly Classified[],
    opts: { supersede: readonly ProposalRow[]; instruction: string | null; quotes: string[] },
  ) =>
    Effect.gen(function* () {
      const inboxItemId = thread.item.id;
      const superseded = new Set(opts.supersede.map((r) => r.id));
      // New refs must not collide with creates that stay in the thread.
      const reserved = new Set(
        thread.rows
          .filter((r) => r.status !== "superseded" && !superseded.has(r.id))
          .map(effectivePayload)
          .flatMap((p) => ownRef(p) ?? []),
      );
      const merged = mergeItemProposals(
        results.map((r) => r.mapped),
        reserved,
      );
      const now = nowIso();
      const messageId = newId();
      const summaries = results.map((r) => r.summary).filter((s): s is string => !!s);
      const questions = results.filter((r) => r.question);
      yield* q((d) =>
        d.insert(inboxMessages).values({
          id: messageId,
          inboxItemId,
          seq: Math.max(-1, ...thread.messages.map((m) => m.seq)) + 1,
          role: "assistant",
          content: { summary: summaries.join("; ") || null },
          createdAt: now,
        }),
      );
      const base = Math.max(-1, ...thread.rows.map((r) => r.seq)) + 1;
      const rows = [
        ...merged.map((m, i) => ({
          id: newId(),
          inboxItemId,
          intakeItemId: results[m.itemIndex]?.itemId ?? null,
          messageId,
          seq: base + i,
          kind: m.payload.kind,
          payload: m.payload,
          rationale: m.rationale,
          evidence: m.evidence,
          confidence: m.confidence,
          status: "pending" as const,
          createdAt: now,
        })),
        ...questions.map((r, i) => ({
          id: newId(),
          inboxItemId,
          intakeItemId: r.itemId,
          messageId,
          seq: base + merged.length + i,
          kind: "needs_clarification",
          payload: { kind: "needs_clarification", question: r.question },
          rationale: null,
          evidence: null,
          confidence: null,
          status: "pending" as const,
          createdAt: now,
        })),
      ];
      if (rows.length) yield* q((d) => d.insert(proposals).values(rows));
      // Each item read or revised is a work event (D61), attached later by the pass.
      yield* withDb(
        recordEvents(
          results.map(({ event: { at, ...data }, summary }) => ({
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
          })),
        ),
      );
      if (superseded.size) {
        yield* q((d) =>
          d
            .update(proposals)
            .set({ status: "superseded", decidedAt: now })
            .where(inArray(proposals.id, [...superseded])),
        );
      }
      // FR-7.2: a requested change is a correction worth learning from.
      // The sprint switch is code's field, so it is no part of the example (D57).
      const before = opts.supersede
        .filter((r) => r.kind !== "needs_clarification")
        .map((r) => withoutCodeFields(effectivePayload(r)));
      if (opts.instruction && before.length) {
        const after = merged.map((m) => withoutCodeFields(m.payload));
        yield* q((d) =>
          d.insert(memories).values({
            id: newId(),
            kind: "example",
            subjectType: "revision",
            content: `Asked "${opts.instruction}": ${before.map(describePayload).join("; ")} -> ${after.map(describePayload).join("; ") || "nothing"}`,
            // Only the instruction's «...» values are markers; the input's are plain quotes.
            exampleInput:
              `${opts.quotes.map(plainQuotes).join("\n")}\nThe user asked: ${opts.instruction}`.slice(
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
      const placeholder = !thread.item.summary || thread.item.summary === "Needs clarification";
      const firstSummary =
        summaries.join("; ") ||
        (questions.length ? "Needs clarification" : (thread.item.summary ?? "Nothing to do"));
      yield* q((d) =>
        d
          .update(inboxItems)
          .set({
            status: "triaged",
            summary: placeholder ? firstSummary : thread.item.summary,
            triage: {
              items: results.length,
              proposals: merged.length,
              questions: questions.length,
              at: now,
            },
          })
          .where(eq(inboxItems.id, inboxItemId)),
      );
      logger.info(
        `Turn ${inboxItemId}: ${results.length} items, ${merged.length} proposals, ${questions.length} questions, ${superseded.size} replaced`,
      );
      return {
        inboxItemId,
        items: results.length,
        proposals: merged.length,
        questions: questions.length,
      } satisfies TriageResult;
    });

  /** A failed turn keeps its message; the error shows until a retry succeeds. */
  const recordFailure = <A, E extends { message: string }, R>(
    inboxItemId: string,
    effect: Effect.Effect<A, E, R>,
  ) =>
    effect.pipe(
      Effect.tapError((e) =>
        q((d) =>
          d
            .update(inboxItems)
            .set({ triage: { error: e.message, at: nowIso() } })
            .where(eq(inboxItems.id, inboxItemId)),
        ).pipe(Effect.ignore),
      ),
    );

  const ctxOf = (thread: Thread, today?: string, source?: string): Ctx => ({
    thread,
    source: source ?? thread.item.source,
    senderPersonId: thread.item.senderPersonId,
    today: today ?? localDate(),
  });

  /** The thread's first input is the user's own typed words: not pasted, not the chat's (D55). */
  const typedByUser = (thread: Thread) => thread.item.source === "typed" && !thread.chatAuthored;

  /** The first turn: split the input and classify every item with the instruction sent with it. */
  const runFirst = (inboxItemId: string, today: string | undefined, progress: Progress) =>
    Effect.gen(function* () {
      const thread = yield* loadThread(inboxItemId);
      const cleaned = cleanInput(thread.item.rawText) || thread.item.rawText.trim();
      const quotes = yield* segment(cleaned, thread.item.source, progress);
      const ownInput = typedByUser(thread);
      const jobs = quotes.map((quote, idx) => ({
        idx,
        quote,
        instructions: thread.instructions,
        revising: [],
        ownInput,
      }));
      const results = yield* classifyAll(
        inboxItemId,
        jobs,
        ctxOf(thread, today),
        progress,
        "Reading",
      );
      return yield* persistTurn(thread, results, { supersede: [], instruction: null, quotes });
    });

  /** Items a typed follow-up is about (D22). */
  const route = (thread: Thread, instruction: string, answers: string | null, progress: Progress) =>
    Effect.gen(function* () {
      const indices = [...thread.current.keys()].sort((a, b) => a - b);
      const question = answers ? thread.rows.find((r) => r.id === answers) : undefined;
      const asked = question?.intakeItemId ? thread.idxOf.get(question.intakeItemId) : undefined;
      if (asked !== undefined) return [asked];
      if (indices.length <= 1) return indices;
      progress("Working out what this is about");
      const items = indices.map((idx) => ({
        quote: thread.current.get(idx)?.quote ?? "",
        proposals: (thread.pendingByIdx.get(idx) ?? [])
          .filter((r) => r.kind !== "needs_clarification")
          .map((r) => describePayload(effectivePayload(r))),
      }));
      return yield* llm
        .object<RouteReplyOutput>("route_reply", {
          schema: buildRouteReplySchema(items.length) as never,
          ...buildRouteReplyPrompt(items, instruction),
          validate: validateRouteReply,
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
    });

  /** Revises items with the thread's instructions; their undecided proposals are replaced. */
  const revise = (
    thread: Thread,
    chosen: readonly number[],
    opts: { instruction: string | null; today?: string; progress: Progress },
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
      const replacing = new Set(
        affected.flatMap((idx) => (thread.pendingByIdx.get(idx) ?? []).map((r) => r.id)),
      );
      const jobs = affected.map((idx) => {
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
      const results = yield* classifyAll(
        thread.item.id,
        jobs,
        ctxOf(thread, opts.today),
        opts.progress,
        "Revising",
      );
      return yield* persistTurn(thread, results, {
        supersede: affected.flatMap((idx) => thread.pendingByIdx.get(idx) ?? []),
        instruction: opts.instruction,
        quotes: jobs.map((j) => j.quote),
      });
    });

  /** Runs the turn for a stored user message. */
  const runReply = (
    inboxItemId: string,
    messageId: string,
    today: string | undefined,
    progress: Progress,
  ) =>
    Effect.gen(function* () {
      const thread = yield* loadThread(inboxItemId);
      const message = thread.messages.find((m) => m.id === messageId);
      const content = UserContentSchema.parse(message?.content ?? { parts: [] });
      const { input, instruction } = splitMessage(content.parts, false, content.inline);
      if (input) {
        // New input joins the thread as new items, instructed by this message only.
        // Pasted text is never the user's own words, whatever source it was given.
        const named = content.source ?? thread.item.source;
        const source = named === "typed" ? "other" : named;
        const cleaned = cleanInput(input) || input.trim();
        const quotes = yield* segment(cleaned, source, progress);
        const start = Math.max(-1, ...thread.current.keys()) + 1;
        const jobs = quotes.map((quote, i) => ({
          idx: start + i,
          quote,
          instructions: instruction ? [instruction] : [],
          revising: [],
          source,
          ownInput: false,
        }));
        const results = yield* classifyAll(
          inboxItemId,
          jobs,
          ctxOf(thread, today, source),
          progress,
          "Reading",
        );
        return yield* persistTurn(thread, results, { supersede: [], instruction: null, quotes });
      }
      if (thread.current.size === 0) return yield* runFirst(inboxItemId, today, progress);
      const chosen = yield* route(thread, instruction ?? "", content.answers ?? null, progress);
      return yield* revise(thread, chosen, { instruction, today, progress });
    });

  const triage = (input: TriageInput) =>
    Effect.gen(function* () {
      // From the message box (D56): a paste that is a value inside a line is not input.
      const parts = input.parts ? mergeParts(input.parts) : null;
      const split = parts ? splitMessage(parts, true, true) : null;
      const typed = parts ? !hasInput(parts, true) : input.source === "typed";
      const text = split ? split.input : (input.text ?? "");
      // Pasted input is never the user's own words (D55): "typed" given with a paste is "other".
      const source: Source = typed ? "typed" : input.source === "typed" ? "other" : input.source;
      if (!text.trim())
        return yield* new IntakeError({ kind: "empty", message: "Paste or type something first." });
      const inboxItemId = newId();
      const now = nowIso();
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
          id: newId(),
          inboxItemId,
          seq: 0,
          role: "user",
          content: {
            ...(parts
              ? { parts, inline: true }
              : { parts: partsOf(text, input.instruction ?? null, typed) }),
            source,
            ...(input.author ? { author: input.author } : {}),
          },
          createdAt: now,
        }),
      );
      return yield* recordFailure(
        inboxItemId,
        runFirst(inboxItemId, input.today, input.onProgress ?? (() => undefined)),
      );
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
      const parts = input.parts ? mergeParts(input.parts) : null;
      const split = parts ? splitMessage(parts, false, true) : null;
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
      const replySource: Source = text && named === "typed" ? "other" : named;
      const now = nowIso();
      const messageId = newId();
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
          },
          createdAt: now,
        }),
      );
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
        runReply(input.inboxItemId, messageId, input.today, input.onProgress ?? (() => undefined)),
      );
    });

  const retriage = (inboxItemId: string) =>
    recordFailure(
      inboxItemId,
      Effect.gen(function* () {
        const thread = yield* loadThread(inboxItemId);
        yield* refuseFeatureThread(thread);
        // A work item's thread holds the secretary's questions, no input to read again (D61).
        if (thread.item.workItemId)
          return yield* new IntakeError({
            kind: "read_only",
            message:
              "This thread holds questions about a work item; there is nothing to read again.",
          });
        const progress: Progress = () => undefined;
        const last = thread.messages.at(-1);
        const firstUser = thread.messages.find((m) => m.role === "user");
        // An unanswered message (the last turn failed) is simply run again.
        if (last?.role === "user" && last.id !== firstUser?.id)
          return yield* runReply(inboxItemId, last.id, undefined, progress);
        if (thread.current.size === 0) return yield* runFirst(inboxItemId, undefined, progress);
        return yield* revise(thread, [...thread.current.keys()], {
          instruction: null,
          progress,
        });
      }),
    );

  return Intake.of({ triage, reply, retriage });
});

export const IntakeLive = Layer.effect(Intake, make);

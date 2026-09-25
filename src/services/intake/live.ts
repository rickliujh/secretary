import { and, asc, eq, inArray } from "drizzle-orm";
import { Effect, Either, Layer } from "effect";
import { inboxItems, inboxMessages, intakeItems, memories, people, proposals } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { logger } from "@/lib/log";
import {
  buildClassifyPrompt,
  buildItemSchema,
  fromPayload,
  type ItemOutput,
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
import { Db, query } from "@/services/db";
import { Llm } from "@/services/llm";
import { describePayload, type ProposalPayload } from "@/services/proposals/schema";
import { Retrieval } from "@/services/retrieval";
import {
  Intake,
  IntakeError,
  localDate,
  type ReplyInput,
  type Source,
  type TriageInput,
  type TriageResult,
} from ".";
import { mergeItemProposals } from "./merge";
import { cleanInput, extractReferences, needsSegmentation, type References } from "./preprocess";
import { partsOf, refsOf, splitMessage, UserContentSchema, withLinkedItems } from "./thread";

const UNSURE_QUESTION =
  "I am not sure what should happen here. What would you like me to do with this?";

const DECIDED = {
  executed: "done",
  approved: "done",
  failed: "done",
  rejected: "rejected",
} as const;

type ProposalRow = typeof proposals.$inferSelect;
type ItemRow = typeof intakeItems.$inferSelect;
type Progress = (message: string) => void;

const payloadOf = (r: ProposalRow) => (r.editedPayload ?? r.payload) as ProposalPayload;

/** One item to classify in this turn. */
type Job = {
  idx: number;
  quote: string;
  instructions: string[];
  /** Undecided proposals being revised; empty for new input. */
  revising: ProposalRow[];
};

type Classified = {
  itemId: string;
  mapped: MappedProposal[];
  question: string | null;
  summary: string | null;
};

const noRefs: References = { issueKeys: [], tickets: [], emails: [], urls: [], contactIds: [] };

const mergeRefs = (a: References, b: References): References => ({
  issueKeys: [...new Set([...a.issueKeys, ...b.issueKeys])],
  tickets: [...new Set([...a.tickets, ...b.tickets])],
  emails: [...new Set([...a.emails, ...b.emails])],
  urls: [...new Set([...a.urls, ...b.urls])],
  contactIds: [...new Set([...a.contactIds, ...b.contactIds])],
});

/** Real issue keys a payload points at, so revisions keep them as candidates. */
const keysOf = (p: ProposalPayload) => {
  const values: (string | null)[] = [];
  if (p.kind === "create_issue") values.push(p.parent, p.epic);
  else if ("target" in p) values.push(p.target);
  if (p.kind === "draft_message") values.push(...p.issueKeys);
  return values.filter((v): v is string => !!v && !v.startsWith("$new:"));
};

const make = Effect.gen(function* () {
  const db = yield* Db;
  const llm = yield* Llm;
  const retrieval = yield* Retrieval;
  const q = <A>(f: Parameters<typeof query<A>>[0]) => Effect.provideService(query(f), Db, db);

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
        return splitMessage(c.data.parts, i === 0).instruction ?? [];
      });
      const decided = rows
        .filter((r) => r.kind !== "needs_clarification" && r.status in DECIDED)
        .map((r) => ({
          outcome: DECIDED[r.status as keyof typeof DECIDED],
          description: describePayload(payloadOf(r)),
        }));
      const createdKeys = rows
        .filter((r) => r.kind === "create_issue" && r.status === "executed")
        .map((r) => (r.result as { issueKey?: string } | null)?.issueKey)
        .filter((k): k is string => !!k);
      const pendingByIdx = new Map<number, ProposalRow[]>();
      for (const r of rows) {
        if (r.status !== "pending" || !r.intakeItemId) continue;
        const idx = idxOf.get(r.intakeItemId);
        if (idx === undefined) continue;
        pendingByIdx.set(idx, [...(pendingByIdx.get(idx) ?? []), r]);
      }
      return {
        item,
        messages,
        rows,
        current,
        idxOf,
        instructions,
        decided,
        createdKeys,
        pendingByIdx,
      };
    });
  type Thread = Effect.Effect.Success<ReturnType<typeof loadThread>>;
  type Ctx = { thread: Thread; source: string; senderPersonId: string | null; today: string };

  /** Retrieval, one schema-bound model call and validation for one item. */
  const classify = (inboxItemId: string, job: Job, ctx: Ctx) =>
    Effect.gen(function* () {
      const contacts = yield* contactsQuery;
      // Stored refs -> $new:1.. for the model; the merge renumbers them afterwards.
      const local = new Map<string, string>();
      for (const r of job.revising) {
        const p = payloadOf(r);
        if (p.kind === "create_issue" && !local.has(p.ref))
          local.set(p.ref, `$new:${local.size + 1}`);
      }
      const pending = job.revising.flatMap((r) => {
        if (r.kind === "needs_clarification") return [];
        const shape = fromPayload(payloadOf(r), local);
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
      const thread: ThreadContext | null =
        job.instructions.length || pending.length || ctx.thread.decided.length
          ? { instructions: job.instructions, decided: ctx.thread.decided, pending }
          : null;
      const references = [
        extractReferences(job.quote, contacts),
        extractReferences(job.instructions.join("\n"), contacts),
        {
          ...noRefs,
          issueKeys: [
            ...job.revising.flatMap((r) => keysOf(payloadOf(r))),
            ...ctx.thread.createdKeys,
          ],
        },
      ].reduce(mergeRefs);
      const snapshot = yield* retrieval.snapshot({
        quote: job.quote,
        source: ctx.source,
        senderPersonId: ctx.senderPersonId,
        references,
        today: ctx.today,
        thread,
      });
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
          question: `I could not turn this into reliable actions: "${job.quote.slice(0, 200)}". What should happen?`,
          summary: null,
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
        mapped: mapItemOutput(value),
        question,
        summary: value.summary,
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
          .map(payloadOf)
          .flatMap((p) => (p.kind === "create_issue" ? [p.ref] : [])),
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
      if (superseded.size) {
        yield* q((d) =>
          d
            .update(proposals)
            .set({ status: "superseded", decidedAt: now })
            .where(inArray(proposals.id, [...superseded])),
        );
      }
      // FR-7.2: a requested change is a correction worth learning from.
      const before = opts.supersede.filter((r) => r.kind !== "needs_clarification").map(payloadOf);
      if (opts.instruction && before.length) {
        const after = merged.map((m) => m.payload);
        yield* q((d) =>
          d.insert(memories).values({
            id: newId(),
            kind: "example",
            subjectType: "revision",
            content: `Asked "${opts.instruction}": ${before.map(describePayload).join("; ")} -> ${after.map(describePayload).join("; ") || "nothing"}`,
            exampleInput: `${opts.quotes.join("\n")}\nThe user asked: ${opts.instruction}`.slice(
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

  /** The first turn: split the input and classify every item with the instruction sent with it. */
  const runFirst = (inboxItemId: string, today: string | undefined, progress: Progress) =>
    Effect.gen(function* () {
      const thread = yield* loadThread(inboxItemId);
      const cleaned = cleanInput(thread.item.rawText) || thread.item.rawText.trim();
      const quotes = yield* segment(cleaned, thread.item.source, progress);
      const jobs = quotes.map((quote, idx) => ({
        idx,
        quote,
        instructions: thread.instructions,
        revising: [],
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
          .map((r) => describePayload(payloadOf(r))),
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
          rows.filter((r) => r.kind !== "needs_clarification").map(payloadOf),
        ]),
      );
      const affected = withLinkedItems(chosen, pendingPayloads).filter((idx) =>
        thread.current.has(idx),
      );
      const jobs = affected.map((idx) => {
        const own = thread.pendingByIdx.get(idx) ?? [];
        // A create from another item that this item points at comes along, so the
        // model can keep the reference.
        const used = new Set(own.map(payloadOf).flatMap(refsOf));
        const borrowed = affected
          .filter((other) => other !== idx)
          .flatMap((other) => thread.pendingByIdx.get(other) ?? [])
          .filter((r) => {
            const p = payloadOf(r);
            return p.kind === "create_issue" && used.has(p.ref);
          });
        return {
          idx,
          quote: thread.current.get(idx)?.quote ?? "",
          instructions: thread.instructions,
          revising: [...borrowed, ...own],
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
      const { input, instruction } = splitMessage(content.parts, false);
      if (input) {
        // New input joins the thread as new items, instructed by this message only.
        const source = content.source ?? thread.item.source;
        const cleaned = cleanInput(input) || input.trim();
        const quotes = yield* segment(cleaned, source, progress);
        const start = Math.max(-1, ...thread.current.keys()) + 1;
        const jobs = quotes.map((quote, i) => ({
          idx: start + i,
          quote,
          instructions: instruction ? [instruction] : [],
          revising: [],
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
      if (!input.text.trim())
        return yield* new IntakeError({ kind: "empty", message: "Paste or type something first." });
      const inboxItemId = newId();
      const now = nowIso();
      yield* q((d) =>
        d.insert(inboxItems).values({
          id: inboxItemId,
          source: input.source,
          senderPersonId: input.senderPersonId,
          rawText: input.text,
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
            parts: partsOf(input.text, input.instruction ?? null, input.source === "typed"),
            source: input.source,
          },
          createdAt: now,
        }),
      );
      return yield* recordFailure(
        inboxItemId,
        runFirst(inboxItemId, input.today, input.onProgress ?? (() => undefined)),
      );
    });

  const reply = (input: ReplyInput) =>
    Effect.gen(function* () {
      const text = input.text?.trim() ?? "";
      const instruction = input.instruction?.trim() || null;
      if (!text && !instruction)
        return yield* new IntakeError({ kind: "empty", message: "Type or paste something first." });
      const thread = yield* loadThread(input.inboxItemId);
      const now = nowIso();
      const messageId = newId();
      yield* q((d) =>
        d.insert(inboxMessages).values({
          id: messageId,
          inboxItemId: input.inboxItemId,
          seq: Math.max(-1, ...thread.messages.map((m) => m.seq)) + 1,
          role: "user",
          content: {
            parts: partsOf(text, instruction, false),
            source: input.source ?? (thread.item.source as Source),
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

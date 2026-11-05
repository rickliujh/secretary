/**
 * FR-20 acceptance (Phase 29) over real HTTP against scripts/mock-jira.ts:
 * real Sync, Intake, Retrieval, Executor, Proposals and DailyNote; the vault's
 * daily note is a fake file with the Rust command's compare-and-swap; only the
 * models are scripted.
 *
 * - With a wait on Sarah for the cert open on PAY-12, "PAY-12: Sarah says the
 *   cert is Friday now" in the note gives one Update wait card in a thread
 *   marked as from the note, and no second card after a second read.
 * - "Lunch with Mia" gives nothing and is not sent again.
 * - "- [ ] send Dana the Q3 numbers" gives one small ask card; editing the line
 *   before approval revises the same thread; ticking it after the ticket exists
 *   proposes closing the ticket (approved here, it closes in Jira).
 * - A line under a "Private" heading reaches no model call.
 * - With the vault connected, a line added on the file side appears on the
 *   page, a line typed on the page appears in the file, and edits on both
 *   sides since the last sync are both kept.
 *
 * FR-20.6 acceptance (Phase 30, D66): a block that made an Epic and a Story,
 * both approved, gives nothing at a second read; editing it gives new cards in
 * the same thread, whose classify call lists the Epic as a candidate and the
 * decisions as already decided; a create repeating the Epic is sent back; a
 * block naming the Story's key, and one the triage assigns to the thread, are
 * new messages there; a to-do copied into the next day's note gives no card.
 *
 * FR-20.7 acceptance (Phase 31, D67), at the service level: see its suite.
 *
 * FR-20.10 acceptance (Phase 35, D71): a screenshot of a request in the note,
 * transcribed (scripted), leads to a card whose evidence quotes it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Either, Layer } from "effect";
import { blockMarks } from "@/components/note/block-marks";
import { dependencies, inboxItems, people, proposals } from "@/db/schema";
import { localDate } from "@/lib/dates";
import { nowIso } from "@/lib/ids";
import { query } from "@/services/db";
import { ExecutorLive } from "@/services/executor/live";
import { Intake } from "@/services/intake";
import { IntakeLive } from "@/services/intake/live";
import { LlmLive } from "@/services/llm/live";
import { imagesOf, makeScriptedModels, type Scripted } from "@/services/llm/test";
import { Proposals } from "@/services/proposals";
import { ProposalsLive } from "@/services/proposals/live";
import { RetrievalLive } from "@/services/retrieval/live";
import { defaultSettings } from "@/services/settings/schema";
import { Sync } from "@/services/sync";
import { SyncLive } from "@/services/sync/live";
import { datesInText } from "@/services/work/dates";
import { readThread, testProvider } from "@/test/helpers";
import { out } from "@/test/intake-layer";
import { jiraSettings, jiraTestLayer } from "@/test/layers";
import { createHandler, generate } from "../../../scripts/mock-jira";
import { DailyNote, NoteFile } from ".";
import { splitBlocks } from "./blocks";
import { blocksOf, markLabel, threadMark, threadSummaries } from "./cards";
import { DailyNoteLive } from "./live";
import { saveBody } from "./queries";
import { readNote } from "./read";
import { makeNoteFileTest } from "./test";

const servers: { stop: (force?: boolean) => void }[] = [];
afterAll(() => {
  for (const s of servers) s.stop(true);
});

const TODAY = localDate();
const FRIDAY = datesInText("Friday", TODAY)[0] ?? "";
const jiraNow = () => new Date().toISOString().replace("Z", "+0000");

const sarahClassified = {
  summary: "Sarah: the cert comes Friday",
  question: null,
  confidence: 0.9,
  proposals: [
    {
      kind: "update_dependency",
      dependencyId: "w-cert",
      waitAction: "reschedule",
      expectedAt: FRIDAY,
      rationale: "Sarah gave a date",
      evidence: "Friday now",
      confidence: 0.9,
    },
  ],
};
const smallAsk = (summary: string) => ({
  summary,
  question: null,
  confidence: 0.9,
  proposals: [
    {
      kind: "create_issue",
      ref: "$new:1",
      smallAsk: "yes",
      summary,
      description: "",
      dueDate: "",
      issueType: "",
      rationale: "A to-do in the note",
      evidence: summary,
      confidence: 0.9,
    },
  ],
});
const triage = (kind: string) =>
  out({ blocks: [{ index: "1", kind, item: "(none)", thread: "(none)" }] });

const VAULT = {
  id: "v1",
  kind: "obsidian" as const,
  name: "Work notes",
  vault: "Work",
  enabled: true,
};

/** The Phase 29 acceptance's scripted answers. */
const phase29 = (): Record<string, Scripted[]> => ({
  "fast-m": [triage("act"), triage("skip"), triage("act")],
  "std-m": [
    out(sarahClassified),
    out(smallAsk("Send Dana the Q3 numbers")),
    out(smallAsk("Send Dana the Q3 and Q4 numbers")),
  ],
});

function setup(scripts: Record<string, Scripted[]> = phase29()) {
  const issues = generate(40);
  const pay = issues.get("PAY-12");
  const me = [...issues.values()].find((i) => i.assignee?.name === "me")?.assignee;
  if (!pay || !me) throw new Error("fixture");
  Object.assign(pay, {
    type: "Story",
    summary: "Renew the payment gateway cert",
    status: "In Progress",
    assignee: me,
    updated: jiraNow(),
  });
  const server = Bun.serve({ port: 0, fetch: createHandler(issues) });
  servers.push(server);
  const s = defaultSettings();
  const base = jiraTestLayer((input, init) => fetch(input, init), {
    ...jiraSettings({ baseUrl: `http://localhost:${server.port}`, trackedEpics: [] }),
    providers: [testProvider],
    tiers: {
      fast: { providerId: "p1", model: "fast-m" },
      standard: { providerId: "p1", model: "std-m" },
      strong: null,
    },
    dataSources: [VAULT],
    smallAsks: {
      projectKey: "OPS",
      label: "small-ask",
      joinActiveSprint: false,
      hintDismissed: false,
      defaultPoints: null,
    },
    secretary: { ...s.secretary, dailyNote: { ...s.secretary.dailyNote, vaultSourceId: "v1" } },
  });
  const models = makeScriptedModels(scripts);
  const file = makeNoteFileTest({ Work: null });
  const llm = Layer.provideMerge(
    LlmLive,
    Layer.merge(Layer.provideMerge(SyncLive, base), models.layer),
  );
  const layer = Layer.provideMerge(
    DailyNoteLive,
    Layer.provideMerge(
      Layer.mergeAll(IntakeLive, ProposalsLive, file.layer),
      Layer.provideMerge(Layer.merge(RetrievalLive, ExecutorLive), llm),
    ),
  );
  return { layer, models, file, issues };
}

const noteThreads = query((d) =>
  d.select().from(inboxItems).where(eq(inboxItems.source, "note")).all(),
);

describe("the daily note against the mock Jira (FR-20 AC, Phase 29)", () => {
  test("cards from the note, once each; revise, close, private and the vault", async () => {
    const { layer, models, file, issues } = setup();
    const fastCalls = () => models.calls.filter((c) => c.model === "fast-m").length;
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* (yield* Sync).run();
          yield* query((d) => d.insert(people).values({ id: "c-sarah", displayName: "Sarah Kim" }));
          yield* query((d) =>
            d.insert(dependencies).values({
              id: "w-cert",
              issueKey: "PAY-12",
              kind: "person",
              label: "the new cert",
              ownerPersonId: "c-sarah",
              status: "waiting",
              requestedAt: nowIso(),
            }),
          );
          const note = yield* DailyNote;
          let body = "PAY-12: Sarah says the cert is Friday now\n";
          yield* note.save(TODAY, body);

          // 1. One Update wait card, in a thread marked as from the note; none on a second read.
          const first = yield* note.read("button");
          const again = yield* note.read("pass");
          const certThreads = yield* noteThreads;
          const cert = yield* readThread(certThreads[0]?.id ?? "");
          const callsAfterCert = fastCalls();

          // 2. "Lunch with Mia": nothing, and not sent again.
          body += "\nLunch with Mia\n";
          yield* note.save(TODAY, body);
          const lunch = yield* note.read("typing");
          const lunchAgain = yield* note.read("pass");
          const callsAfterLunch = fastCalls();

          // 3. A to-do: one small ask card; editing it before approval revises that thread.
          yield* note.save(TODAY, `${body}\n- [ ] send Dana the Q3 numbers\n`);
          const todo = yield* note.read("typing");
          const todoThread = (yield* noteThreads).find((t) => t.id !== cert.item?.id)?.id ?? "";
          yield* note.save(TODAY, `${body}\n- [ ] send Dana the Q3 and Q4 numbers\n`);
          const edited = yield* note.read("typing");
          const threadsAfterEdit = (yield* noteThreads).length;
          const revised = yield* readThread(todoThread);

          // Approved: the ticket exists in Jira. Ticking the line proposes closing it.
          const create = revised.props.find(
            (p) => p.kind === "create_issue" && p.status === "pending",
          );
          yield* (yield* Proposals).approve(create?.id ?? "");
          const createdRow = yield* query((d) =>
            d
              .select()
              .from(proposals)
              .where(eq(proposals.id, create?.id ?? ""))
              .get(),
          );
          const key = (createdRow?.result as { issueKey?: string } | null)?.issueKey ?? "";
          yield* note.save(TODAY, `${body}\n- [x] send Dana the Q3 and Q4 numbers\n`);
          const ticked = yield* note.read("typing");
          const closeRow = (yield* readThread(todoThread)).props.find(
            (p) => p.kind === "transition_issue",
          );
          yield* (yield* Proposals).approve(closeRow?.id ?? "");

          // 4. A private line reaches no model.
          body = `${body}\n- [x] send Dana the Q3 and Q4 numbers\n\n## Private\nsalary review with HR\n`;
          yield* note.save(TODAY, body);
          const callsBeforePrivate = models.calls.length;
          const priv = yield* note.read("button");
          const callsAfterPrivate = models.calls.length;

          // 5. The vault: the file holds the page; each side's lines reach the other.
          const fileAfterReads = file.files.get("Work");
          file.files.set("Work", `${fileAfterReads}from obsidian\n`);
          yield* note.sync();
          const pageAfterFileEdit = (yield* note.load(TODAY)).body;
          yield* note.save(TODAY, `typed first\n${pageAfterFileEdit}`);
          yield* note.sync();
          const fileAfterPageEdit = file.files.get("Work");
          file.files.set("Work", `${fileAfterPageEdit}obsidian again\n`);
          yield* note.save(
            TODAY,
            `${fileAfterPageEdit}`.replace("typed first", "typed first, edited"),
          );
          const both = yield* note.sync();
          const merged = (yield* note.load(TODAY)).body;

          const proposalsNow = yield* query((d) => d.select().from(proposals).all());
          return {
            first,
            again,
            certThreads,
            cert,
            callsAfterCert,
            lunch,
            lunchAgain,
            callsAfterLunch,
            todo,
            edited,
            threadsAfterEdit,
            revised,
            created: createdRow,
            key,
            ticked,
            closeRow,
            priv,
            callsBeforePrivate,
            callsAfterPrivate,
            fileAfterReads,
            pageAfterFileEdit,
            fileAfterPageEdit,
            both,
            merged,
            fileFinal: file.files.get("Work"),
            proposalsNow,
          };
        }),
        layer,
      ),
    );

    // 1. The cert: one Update wait card, marked as from the note; no second card.
    expect(r.first).toMatchObject({ cards: 1, called: true });
    expect(r.again).toMatchObject({ cards: 0, called: false });
    expect(r.certThreads).toHaveLength(1);
    expect(r.cert.item?.source).toBe("note");
    expect(r.cert.messages[0]?.content).toMatchObject({ source: "note", noteDate: TODAY });
    expect(r.cert.props.map((p) => p.kind)).toEqual(["update_dependency"]);
    expect(r.cert.props[0]?.payload).toMatchObject({ dependencyId: "w-cert", expectedAt: FRIDAY });
    expect(r.callsAfterCert).toBe(1);

    // 2. Lunch: left alone, never sent again.
    expect(r.lunch).toMatchObject({ skippedBlocks: 1, cards: 0 });
    expect(r.lunchAgain.called).toBe(false);
    expect(r.callsAfterLunch).toBe(2);

    // 3. The to-do: one card, revised in place, then closed once ticked.
    expect(r.todo).toMatchObject({ cards: 1 });
    expect(r.edited).toMatchObject({ revised: 1, cards: 0, called: false });
    expect(r.threadsAfterEdit).toBe(2);
    expect(r.revised.props.map((p) => [p.kind, p.status])).toEqual([
      ["create_issue", "superseded"],
      ["create_issue", "pending"],
    ]);
    expect(r.created?.status).toBe("executed");
    expect(r.key).toMatch(/^OPS-\d+$/);
    expect(r.ticked).toMatchObject({ closed: 1, called: false });
    expect(r.closeRow?.payload).toEqual({
      kind: "transition_issue",
      target: r.key,
      toStatus: "Done",
    });

    // 4. Private: no model call, and the words are in no prompt.
    expect(r.priv).toMatchObject({ privateBlocks: 1, called: false });
    expect(r.callsAfterPrivate).toBe(r.callsBeforePrivate);
    for (const c of models.calls) expect(JSON.stringify(c.prompt)).not.toContain("salary");

    // 5. The vault.
    expect(r.fileAfterReads).toContain("PAY-12: Sarah says the cert is Friday now");
    expect(r.fileAfterReads).toContain("- [x] send Dana the Q3 and Q4 numbers");
    expect(r.pageAfterFileEdit.endsWith("from obsidian\n")).toBe(true);
    expect(r.fileAfterPageEdit?.startsWith("typed first\n")).toBe(true);
    expect(r.both).toMatchObject({ state: "synced" });
    expect(r.merged.startsWith("typed first, edited\n")).toBe(true);
    expect(r.merged.endsWith("obsidian again\n")).toBe(true);
    expect(r.fileFinal).toBe(r.merged);

    // Every Jira write went through an approved proposal.
    expect(r.proposalsNow.filter((p) => p.status === "executed").map((p) => p.kind)).toEqual([
      "create_issue",
      "transition_issue",
    ]);
    expect([...issues.values()].find((i) => i.key === r.key)?.status).toBe("Done");
  });
});

/**
 * FR-20.6 acceptance (Phase 30, D66): the note as one conversation per topic.
 * Keys and thread ids are made while the test runs, so the scripted answers
 * that name them read them when the model is called.
 */
describe("one conversation per topic against the mock Jira (FR-20.6 AC, Phase 30)", () => {
  const made = { epic: "", story: "", qoder: "" };
  /** A scripted answer built when the model is called. */
  const later = (value: () => unknown) => ({
    get text() {
      return JSON.stringify(value());
    },
  });
  const e = { rationale: "From the note", evidence: "Qoder", confidence: 0.9 };
  const create = (fields: Record<string, unknown>) => ({
    kind: "create_issue",
    ref: "$new:1",
    projectKey: "PAY",
    issueType: "Story",
    description: "",
    parent: "",
    epic: "",
    priority: "",
    assignee: "",
    dueDate: "",
    smallAsk: "no",
    ...e,
    ...fields,
  });
  const answer = (summary: string, proposals: unknown[]) => ({
    summary,
    question: null,
    confidence: 0.9,
    proposals,
  });
  const comment = (body: string) =>
    later(() => answer(body, [{ kind: "add_comment", target: made.story, body, ...e }]));
  const QODER =
    "Create an epic for the Qoder migration of the merchant SDK; first step is the SDK audit";
  const EPIC = "Qoder migration of the merchant SDK";

  test("decided cards are not made again; edits, named keys and the triage's choice continue the thread", async () => {
    const { layer, models } = setup({
      "fast-m": [
        triage("act"),
        triage("act"),
        // The block naming the Story's key: act, and code picks the thread.
        triage("act"),
        later(() => ({
          blocks: [{ index: "1", kind: "act", item: "(none)", thread: made.qoder }],
        })),
      ],
      "std-m": [
        out(smallAsk("Send Dana the Q3 numbers")),
        out(
          answer("Qoder migration epic and the SDK audit", [
            create({ issueType: "Epic", summary: EPIC }),
            create({ ref: "$new:2", summary: "Audit the merchant SDK", epic: "$new:1" }),
          ]),
        ),
        // The edit: first the epic again (sent back), then only the new step.
        later(() => answer("Qoder docs", [create({ issueType: "Epic", summary: EPIC })])),
        later(() =>
          answer("Qoder docs", [create({ summary: "Write the Qoder SDK docs", epic: made.epic })]),
        ),
        comment("The SDK audit has started; Ana pairs on it."),
        comment("The SDK docs wait until the audit is done."),
      ],
    });
    const fastCalls = () => models.calls.filter((c) => c.model === "fast-m").length;
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* (yield* Sync).run();
          const note = yield* DailyNote;
          const proposalsSvc = yield* Proposals;
          const pendingOf = (id: string) =>
            Effect.map(readThread(id), (t) =>
              t.props.filter((p) => p.status === "pending").map((p) => p.id),
            );

          // Two days ago: the to-do, one small ask card.
          const earlier = new Date(Date.now() - 2 * 86_400_000);
          yield* saveBody(localDate(earlier), "- [ ] send Dana the Q3 numbers\n");
          yield* readNote("button", { now: earlier });

          // Today: the to-do copied over, and the Qoder epic with its first step.
          let body = `- [ ] send Dana the Q3 numbers\n\n${QODER}\n`;
          yield* note.save(TODAY, body);
          const first = yield* note.read("button");
          const qoder = (yield* noteThreads).find((t) => t.rawText.includes("Qoder"));
          made.qoder = qoder?.id ?? "";
          const created = yield* pendingOf(made.qoder);
          for (const id of created) yield* proposalsSvc.approve(id);
          const rows = yield* query((d) =>
            d.select().from(proposals).where(eq(proposals.inboxItemId, made.qoder)).all(),
          );
          const keyOf = (type: string) =>
            (
              rows.find((p) => (p.payload as { issueType?: string }).issueType === type)
                ?.result as { issueKey?: string } | null
            )?.issueKey ?? "";
          made.epic = keyOf("Epic");
          made.story = keyOf("Story");

          // The unchanged note again: nothing.
          const unchanged = yield* note.read("pass");
          const callsUnchanged = models.calls.length;

          // The block edited after both were approved: new cards in the same thread.
          body = `- [ ] send Dana the Q3 numbers\n\n${QODER}, then the SDK docs\n`;
          yield* note.save(TODAY, body);
          const edited = yield* note.read("typing");

          // A new block naming the Story's key continues the thread.
          body += `\n${made.story} audit started, Ana pairs with me\n`;
          yield* note.save(TODAY, body);
          const named = yield* note.read("typing");

          // A block the triage assigns to the thread: a new message there.
          body += "\nAna says the merchant SDK docs can wait until after the audit\n";
          yield* note.save(TODAY, body);
          const picked = yield* note.read("typing");

          return {
            first,
            unchanged,
            callsUnchanged,
            edited,
            named,
            picked,
            threads: yield* noteThreads,
            thread: yield* readThread(made.qoder),
          };
        }),
        layer,
      ),
    );

    // The copied to-do made no second card; the Qoder block made one thread.
    expect(r.first).toMatchObject({ cards: 1, continued: 0 });
    expect(r.threads).toHaveLength(2);
    expect(made.epic).toMatch(/^PAY-\d+$/);
    expect(made.story).toMatch(/^PAY-\d+$/);

    // A second read of the unchanged note: nothing, and no model call.
    expect(r.unchanged).toMatchObject({ cards: 0, revised: 0, continued: 0, called: false });
    expect(r.callsUnchanged).toBe(4);

    // The edit revised the thread; its classify call knew the epic and the decisions.
    expect(r.edited).toMatchObject({ revised: 1, cards: 0 });
    const std = models.calls.filter((c) => c.model === "std-m");
    const revise = JSON.stringify(std[2]?.prompt);
    expect(revise).toContain(`- ${made.epic} [Epic`);
    expect(revise).toContain("created: made on your approval in the last two weeks");
    expect(revise).toContain("## Already decided in this conversation");
    expect(revise).toContain(`Create Epic in PAY`);
    // The repeated epic was sent back for repair.
    expect(JSON.stringify(std[3]?.prompt)).toContain(
      `${made.epic} already exists with nearly the same summary`,
    );

    // The named key and the triage's choice continued the same thread.
    expect(r.named).toMatchObject({ continued: 1, cards: 0, called: true });
    expect(r.picked).toMatchObject({ continued: 1, cards: 0, called: true });
    expect(fastCalls()).toBe(4);
    expect(r.threads).toHaveLength(2);
    const users = r.thread.messages.filter((m) => m.role === "user");
    expect(users).toHaveLength(4);
    expect(users[2]?.content).toMatchObject({ asInput: true, source: "note", noteDate: TODAY });
    expect(users[3]?.content).toMatchObject({ asInput: true, source: "note", noteDate: TODAY });
    expect(r.thread.props.filter((p) => p.status === "pending").map((p) => p.kind)).toEqual([
      "create_issue",
      "add_comment",
      "add_comment",
    ]);
    expect(
      r.thread.props.filter((p) => p.kind === "create_issue" && p.status === "pending")[0]?.payload,
    ).toMatchObject({ issueType: "Story", epic: made.epic });
  });
});

/**
 * FR-20.7 acceptance (Phase 31, D67) at the service level: what the page's
 * marks and cards read (`blocksOf`, `threadSummaries`, the mark's state)
 * after a reading, an approval in the card, a reply typed in it and a
 * question's choice; Ask on a block the reading left alone, then an edit of
 * it; no Ask on a private block.
 */
describe("cards on the note's blocks against the mock Jira (FR-20.7 AC, Phase 31)", () => {
  test("count, approve, reply, a choice, Ask and its revision, private", async () => {
    const { layer, models } = setup({
      "fast-m": [
        out({
          blocks: [
            { index: "1", kind: "act", item: "(none)", thread: "(none)" },
            { index: "2", kind: "skip", item: "(none)", thread: "(none)" },
          ],
        }),
      ],
      "std-m": [
        out(smallAsk("Send Dana the Q3 numbers")),
        out({
          summary: "Send Dana the Q3 numbers",
          question: "Should Mia be a watcher on the ticket, or copied on the mail to Dana?",
          confidence: 0.9,
          proposals: [],
        }),
        // The answer leads to one more card.
        out(smallAsk("Mail Dana the Q3 numbers with Mia copied")),
        out(smallAsk("Book the room for Friday")),
        out(smallAsk("Book the big room for Friday")),
      ],
    });
    const badgeOf = (id: string) =>
      Effect.map(threadSummaries([id]), (t) => (t[0] ? markLabel(threadMark(t[0])) : "none"));
    /** The marks the page shows for the note, from the same queries. */
    const marksOf = (body: string) =>
      Effect.gen(function* () {
        const rows = yield* blocksOf(TODAY);
        const ids = rows.map((b) => b.inboxItemId).filter((id): id is string => !!id);
        const threads = yield* threadSummaries(ids);
        return blockMarks(body, {
          privateHeading: "Private",
          rows: new Map(rows.map((b) => [b.hash, b])),
          threads: new Map(threads.map((t) => [t.id, t])),
          reads: true,
        }).marks.map((m) => m.state);
      });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* (yield* Sync).run();
          const note = yield* DailyNote;
          const body =
            "- [ ] send Dana the Q3 numbers\n\nbook the room for Friday\n\n## Private\nsalary review with HR\n";
          yield* note.save(TODAY, body);
          const read = yield* note.read("button");
          const marksAfterRead = yield* marksOf(body);
          const rows = yield* blocksOf(TODAY);
          const todo = rows.find((b) => b.status === "acted")?.inboxItemId ?? "";
          const afterRead = yield* badgeOf(todo);

          // Approved in the card (the Inbox's approve): the mark and the Inbox agree.
          const card = (yield* readThread(todo)).props.find((p) => p.kind === "create_issue");
          yield* (yield* Proposals).approve(card?.id ?? "");
          const afterApprove = yield* badgeOf(todo);
          const marksAfterApprove = yield* marksOf(body);
          const summary = (yield* threadSummaries([todo]))[0];
          const inboxAfterApprove = yield* readThread(todo);

          // A reply typed in the card is a turn of the same thread.
          yield* (yield* Intake).reply({
            inboxItemId: todo,
            parts: [{ type: "typed", text: "copy Mia on it" }],
          });
          const afterReply = yield* readThread(todo);
          const afterReplyBadge = yield* badgeOf(todo);

          // A choice answers the question, as the card's choice button sends it.
          const question = afterReply.props.find(
            (p) => p.kind === "needs_clarification" && p.status === "pending",
          );
          yield* (yield* Intake).reply({
            inboxItemId: todo,
            parts: [{ type: "typed", text: "Copied on the mail" }],
            answers: question?.id ?? null,
          });
          const afterChoice = yield* readThread(todo);
          const afterChoiceBadge = yield* badgeOf(todo);

          // Ask on the block the reading left alone: a thread and its mark.
          const room = splitBlocks(body).find((b) => b.text.startsWith("book the room"));
          const asked = yield* note.ask(TODAY, room?.hash ?? "");
          const afterAsk = yield* badgeOf(asked.inboxItemId);
          const marksAfterAsk = yield* marksOf(body);
          const roomRow = (yield* blocksOf(TODAY)).find((b) => b.hash === room?.hash);
          // Editing it afterwards revises that thread.
          yield* note.save(TODAY, body.replace("book the room", "book the big room"));
          const edit = yield* note.read("typing");
          const roomThread = yield* readThread(asked.inboxItemId);

          // A private block offers no Ask.
          const salary = splitBlocks(body).find((b) => b.private);
          const priv = yield* Effect.either(note.ask(TODAY, salary?.hash ?? ""));
          return {
            read,
            marksAfterRead,
            afterRead,
            afterApprove,
            marksAfterApprove,
            summary,
            inboxAfterApprove,
            afterReply,
            afterReplyBadge,
            question,
            afterChoice,
            afterChoiceBadge,
            todo,
            asked,
            afterAsk,
            marksAfterAsk,
            roomRow,
            edit,
            roomThread,
            priv,
            threads: yield* noteThreads,
          };
        }),
        layer,
      ),
    );
    expect(r.read).toMatchObject({ cards: 1, skippedBlocks: 1, privateBlocks: 1 });
    // The block that made a card carries the count 1; the one left alone a quiet mark; private a lock.
    expect(r.marksAfterRead).toEqual([
      { kind: "waiting", count: 1, questions: 0 },
      { kind: "alone" },
      { kind: "private" },
    ]);
    expect(r.afterRead).toBe("1 card waiting");
    expect(r.afterApprove).toBe("approved");
    expect(r.marksAfterApprove[0]).toEqual({ kind: "done", ended: "approved" });
    expect(r.inboxAfterApprove.props.map((p) => p.status)).toEqual(["executed"]);
    expect(r.summary?.created).toHaveLength(1);
    expect(r.summary?.created[0]).toMatch(/^OPS-\d+$/);
    // The reply is the thread's next user turn; no new thread.
    const users = r.afterReply.messages.filter((m) => m.role === "user");
    expect(users).toHaveLength(2);
    expect(users[1]?.content).toMatchObject({ parts: [{ type: "typed", text: "copy Mia on it" }] });
    expect(r.afterReplyBadge).toBe("1 question");
    // The choice answered it: the question is closed with the answer.
    expect(r.question).toBeDefined();
    expect(r.afterChoice.props.find((p) => p.id === r.question?.id)).toMatchObject({
      status: "executed",
      result: { answer: "Copied on the mail" },
    });
    expect(r.afterChoice.messages.filter((m) => m.role === "user")).toHaveLength(3);
    // No question waits any more: the new card is what the mark counts.
    expect(r.afterChoiceBadge).toBe("1 card waiting");
    expect(r.afterAsk).toBe("1 card waiting");
    expect(r.marksAfterAsk[1]).toEqual({ kind: "waiting", count: 1, questions: 0 });
    expect(r.roomRow).toMatchObject({ status: "acted", inboxItemId: r.asked.inboxItemId });
    expect(r.edit).toMatchObject({ revised: 1, cards: 0, called: false });
    expect(r.roomThread.props.map((p) => [p.kind, p.status])).toEqual([
      ["create_issue", "superseded"],
      ["create_issue", "pending"],
    ]);
    expect(r.threads.map((t) => t.id).sort()).toEqual([r.todo, r.asked.inboxItemId].sort());
    expect(Either.isLeft(r.priv) && r.priv.left).toMatchObject({ kind: "private" });
    for (const c of models.calls) expect(JSON.stringify(c.prompt)).not.toContain("salary");
  });
});

/**
 * FR-20.10 acceptance (Phase 35, D71): a screenshot of a request pasted into
 * the note, with the user's line above it, is transcribed once (scripted) and
 * leads to the card a pasted text would; the proposal's evidence quotes the
 * transcript, approving it creates the ticket, and the image is not sent again.
 */
describe("images in the note are read against the mock Jira (FR-20.10 AC, Phase 35)", () => {
  test("a screenshot of a request leads to a card whose evidence quotes it", async () => {
    const REQUEST = "Dana Lee (09:41): Could you send me the Q3 revenue numbers by Friday?";
    const request = {
      ...smallAsk("Send Dana the Q3 revenue numbers"),
      proposals: [
        {
          ...smallAsk("Send Dana the Q3 revenue numbers").proposals[0],
          rationale: "Dana asked in the pasted chat",
          evidence: "Could you send me the Q3 revenue numbers by Friday?",
        },
      ],
    };
    const { layer, models } = setup({
      "fast-m": [triage("act")],
      "std-m": [
        out({
          kind: "chat",
          text: REQUEST,
          description: "A Teams chat where Dana asks for numbers.",
        }),
        out(request),
      ],
    });
    const r = await Effect.runPromise(
      Effect.provide(
        Effect.gen(function* () {
          yield* (yield* Sync).run();
          const note = yield* DailyNote;
          // Pasted in the editor: saved into the vault and linked as Obsidian links it.
          const saved = yield* (yield* NoteFile).saveImage(
            "Work",
            new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]),
            "png",
          );
          const body = `do this one\n${saved.link}\n`;
          yield* note.save(TODAY, body);
          const first = yield* note.read("button");
          const again = yield* note.read("pass");
          const threads = yield* noteThreads;
          const thread = yield* readThread(threads[0]?.id ?? "");
          const card = thread.props[0];
          yield* (yield* Proposals).approve(card?.id ?? "");
          const done = yield* query((d) =>
            d
              .select()
              .from(proposals)
              .where(eq(proposals.id, card?.id ?? ""))
              .get(),
          );
          return { first, again, thread, done, body, page: (yield* note.load(TODAY)).body };
        }),
        layer,
      ),
    );
    expect(r.first).toMatchObject({ cards: 1, waiting: 0, called: true });
    expect(r.again).toMatchObject({ cards: 0, called: false });
    // One image went to a model; the classify call read the transcript as pasted input.
    expect(models.calls.filter((c) => imagesOf(c).length)).toHaveLength(1);
    const classify = models.calls.filter((c) => c.model === "std-m")[1];
    const classifyText = ((classify?.prompt ?? []) as { role: string; content: unknown }[])
      .flatMap((m) =>
        typeof m.content === "string"
          ? [m.content]
          : (m.content as { text?: string }[]).map((p) => p.text ?? ""),
      )
      .join("\n");
    // The transcript is inside the Input section's untrusted wrapper, not a trusted line.
    const input = /## Input\n<untrusted_input[^>]*>\n([\s\S]*?)\n<\/untrusted_input>/.exec(
      classifyText,
    );
    expect(input?.[1]).toContain(REQUEST);
    expect(input?.[1]).toContain("[Image: Pasted image 1.png:");
    expect(classifyText.split(REQUEST)).toHaveLength(2);
    expect(r.thread.messages[0]?.content).toMatchObject({
      source: "note",
      parts: [
        { type: "typed", text: "do this one\n" },
        {
          type: "pasted",
          text: `[Image: Pasted image 1.png: A Teams chat where Dana asks for numbers.]\n${REQUEST}`,
        },
      ],
    });
    expect(r.thread.props.map((p) => p.kind)).toEqual(["create_issue"]);
    expect(REQUEST).toContain(r.thread.props[0]?.evidence ?? "(none)");
    expect(r.done?.status).toBe("executed");
    // The note itself is unchanged: the link stays as written.
    expect(r.page).toBe(r.body);
  });
});

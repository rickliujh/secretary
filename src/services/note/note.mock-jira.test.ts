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
 */
import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { dependencies, inboxItems, people, proposals } from "@/db/schema";
import { localDate } from "@/lib/dates";
import { nowIso } from "@/lib/ids";
import { query } from "@/services/db";
import { ExecutorLive } from "@/services/executor/live";
import { IntakeLive } from "@/services/intake/live";
import { LlmLive } from "@/services/llm/live";
import { makeScriptedModels } from "@/services/llm/test";
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
import { DailyNote } from ".";
import { DailyNoteLive } from "./live";
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
const triage = (kind: string) => out({ blocks: [{ index: "1", kind, item: "(none)" }] });

const VAULT = {
  id: "v1",
  kind: "obsidian" as const,
  name: "Work notes",
  vault: "Work",
  enabled: true,
};

function setup() {
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
  const models = makeScriptedModels({
    "fast-m": [triage("act"), triage("skip"), triage("act")],
    "std-m": [
      out(sarahClassified),
      out(smallAsk("Send Dana the Q3 numbers")),
      out(smallAsk("Send Dana the Q3 and Q4 numbers")),
    ],
  });
  const file = makeNoteFileTest({ Work: null });
  const llm = Layer.provideMerge(
    LlmLive,
    Layer.merge(Layer.provideMerge(SyncLive, base), models.layer),
  );
  const layer = Layer.provideMerge(
    DailyNoteLive.pipe(Layer.provide(file.layer)),
    Layer.provideMerge(
      Layer.merge(IntakeLive, ProposalsLive),
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

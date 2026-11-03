import { describe, expect, test } from "bun:test";
import { type MarkState, type ThreadSummary, threadMark } from "@/services/note/cards";
import type { ProposalPayload } from "@/services/proposals/schema";
import type { BlockMark } from "./block-marks";
import { actionLines, cardEntries, cardHead, failedTurn } from "./card-content";

const summary = (over: Partial<ThreadSummary> = {}): ThreadSummary => ({
  id: "t1",
  status: "triaged",
  summary: "Migrate QoderCN",
  error: null,
  waiting: 0,
  questions: 0,
  approved: 0,
  failed: 0,
  created: [],
  ...over,
});

const mark = (state: MarkState, over: Partial<BlockMark> = {}): BlockMark => ({
  key: "k",
  hash: "h",
  line: 0,
  toLine: 0,
  row: null,
  changed: false,
  private: false,
  thread: null,
  state,
  ...over,
});

const today = { editable: true, reads: true };

describe("the card's head per state (D67)", () => {
  const withThread = (t: ThreadSummary) =>
    cardHead(mark(threadMark(t), { thread: "t1" }), t, today);

  test("cards waiting: the count, the thread's rows, a reply, Open in Inbox", () => {
    expect(withThread(summary({ waiting: 2 }))).toMatchObject({
      title: "From this line",
      pill: "2 cards waiting",
      tone: "waiting",
      body: "thread",
      reply: true,
      inbox: true,
      ask: false,
    });
  });

  test("a question: needs you", () => {
    expect(withThread(summary({ questions: 1 }))).toMatchObject({
      title: "One question before I act",
      pill: "needs you",
      tone: "warn",
      body: "thread",
      reply: true,
    });
  });

  test("done: approved, dismissed, nothing left", () => {
    expect(withThread(summary({ approved: 1 }))).toMatchObject({ pill: "approved", tone: "ok" });
    expect(withThread(summary({ status: "dismissed", waiting: 1 }))).toMatchObject({
      pill: "dismissed",
      tone: "muted",
    });
    expect(withThread(summary())).toMatchObject({ pill: "nothing left", tone: "muted" });
  });

  test("failed: a turn that did not go through, or a card that failed to run", () => {
    expect(withThread(summary({ error: "Timed out" }))).toMatchObject({
      title: "Did not go through",
      pill: "error",
      tone: "bad",
      reply: true,
    });
    expect(withThread(summary({ approved: 1, failed: 1 }))).toMatchObject({
      pill: "1 failed",
    });
  });

  test("a failed reply shows over approved and waiting cards", () => {
    expect(withThread(summary({ error: "Timed out", approved: 1, waiting: 2 }))).toMatchObject({
      title: "Did not go through",
      pill: "error",
    });
  });

  test("Try again: the thread's error while its last message is the user's, as in the Inbox", () => {
    const user = { role: "user" };
    const assistant = { role: "assistant" };
    // A reply that failed after cards were approved: still offered.
    expect(failedTurn({ error: "Timed out" }, [user, assistant, user])).toBe("Timed out");
    expect(failedTurn({ error: "Timed out" }, [user, assistant])).toBeNull();
    expect(failedTurn({ error: null }, [user])).toBeNull();
    expect(failedTurn({ error: "x" }, [])).toBeNull();
  });

  test("noted: the work item's name and Ask", () => {
    const row = {
      hash: "h",
      status: "context" as const,
      inboxItemId: null,
      workItemId: "w",
      workItemName: "Renew the payment gateway cert",
    };
    expect(cardHead(mark({ kind: "noted" }, { row }), undefined, today)).toMatchObject({
      title: "Noted on Renew the payment gateway cert",
      pill: "context",
      tone: "note",
      body: "noted",
      ask: true,
      reply: false,
      inbox: false,
    });
  });

  test("left alone: nothing for the secretary, and Ask", () => {
    expect(cardHead(mark({ kind: "alone" }), undefined, today)).toMatchObject({
      title: "Nothing for the secretary",
      pill: "left alone",
      body: "alone",
      ask: true,
    });
  });

  test("not read yet: Read this now on today's note only", () => {
    expect(cardHead(mark({ kind: "unread" }), undefined, today)).toMatchObject({
      title: "Not read yet",
      body: "unread",
      readNow: true,
      ask: false,
    });
    expect(
      cardHead(mark({ kind: "not_read" }), undefined, { editable: false, reads: false }),
    ).toMatchObject({ body: "not_read", ask: true, readNow: false });
  });

  test("private: never sent, no Ask", () => {
    expect(cardHead(mark({ kind: "private" }, { private: true }), undefined, today)).toMatchObject({
      title: "Private",
      pill: "never sent",
      body: "private",
      ask: false,
      reply: false,
    });
  });

  test("a block changed since it was read keeps its thread's card, marked changed", () => {
    const t = summary({ waiting: 1 });
    const head = cardHead(mark({ kind: "unread" }, { thread: "t1", changed: true }), t, today);
    expect(head).toMatchObject({
      pill: "1 card waiting",
      body: "thread",
      changed: true,
      readNow: true,
      reply: true,
    });
  });
});

type P = {
  id: string;
  intakeItemId: string | null;
  kind: string;
  status: string;
  seq: number;
  payload: unknown;
  editedPayload: unknown;
  bundleId: string | null;
};
let seq = 0;
const prop = (kind: string, status: string, payload: unknown, over: Partial<P> = {}): P => ({
  id: `p${seq}`,
  intakeItemId: "i1",
  kind,
  status,
  seq: seq++,
  payload,
  editedPayload: null,
  bundleId: null,
  ...over,
});
const create = (summary: string, extra: Record<string, unknown> = {}) => ({
  kind: "create_issue",
  projectKey: "PAY",
  issueType: "Epic",
  summary,
  descriptionMd: "",
  labels: [],
  joinSprint: false,
  ref: "$new:1",
  ...extra,
});

describe("the card's rows (D67)", () => {
  test("waiting, failed, done and question rows; replaced, rejected and answered left out", () => {
    const list = [
      prop("create_issue", "pending", create("Migrate QoderCN")),
      prop("add_comment", "failed", { kind: "add_comment", target: "PAY-1", bodyMd: "x" }),
      prop("add_comment", "executed", { kind: "add_comment", target: "PAY-40", bodyMd: "y" }),
      prop("needs_clarification", "pending", { kind: "needs_clarification", question: "Who?" }),
      prop("needs_clarification", "rejected", { kind: "needs_clarification", question: "Old?" }),
      prop("create_issue", "superseded", create("Old")),
      prop("create_issue", "rejected", create("No")),
    ];
    expect(
      cardEntries(list).map((e) =>
        e.type === "track" || e.type === "bundle" ? e.type : [e.type, e.proposal.status],
      ),
    ).toEqual([
      ["action", "pending"],
      ["action", "failed"],
      ["done", "executed"],
      ["question", "pending"],
    ]);
  });

  test("a playbook bundle is one row, first; a small ask and its wait are one Track row", () => {
    const list = [
      prop("add_comment", "pending", { kind: "add_comment", target: "PAY-1", bodyMd: "x" }),
      prop("create_issue", "pending", create("Send Dana the Q3 numbers", { smallAsk: true }), {
        intakeItemId: "i2",
      }),
      prop(
        "link_dependency",
        "pending",
        {
          kind: "link_dependency",
          target: "$new:1",
          label: "Dana",
          dependencyKind: "person",
        },
        { intakeItemId: "i2" },
      ),
      prop(
        "transition_issue",
        "pending",
        { kind: "transition_issue", target: "PAY-2", toStatus: "Done" },
        {
          bundleId: "b1",
        },
      ),
      prop(
        "add_comment",
        "pending",
        { kind: "add_comment", target: "PAY-2", bodyMd: "z" },
        {
          bundleId: "b1",
        },
      ),
    ];
    const entries = cardEntries(list);
    expect(entries.map((e) => e.type)).toEqual(["bundle", "action", "track"]);
    const bundle = entries[0];
    expect(bundle?.type === "bundle" && bundle.proposals).toHaveLength(2);
    const track = entries[2];
    expect(track?.type === "track" && track.members).toHaveLength(1);
  });

  test("an action row's lines: the kind and target, then what it says", () => {
    expect(
      actionLines(
        create("Migrate QoderCN to the international plan") as unknown as ProposalPayload,
      ),
    ).toEqual({ kind: "Create Epic · PAY", what: "Migrate QoderCN to the international plan" });
    expect(
      actionLines(
        create("Work out the process", {
          issueType: "Story",
          epic: "$new:1",
        }) as unknown as ProposalPayload,
      ).kind,
    ).toBe("Create Story · PAY · under the new epic");
    expect(
      actionLines({ kind: "add_comment", target: "PAY-40", bodyMd: "Process:\n\npartner form" }),
    ).toEqual({ kind: "Comment on PAY-40", what: "Process: partner form" });
    expect(
      actionLines({ kind: "transition_issue", target: "PAY-12", toStatus: "In review" }),
    ).toEqual({ kind: "Move", what: "Move PAY-12 to In review" });
  });
});

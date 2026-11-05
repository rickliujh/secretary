/**
 * Ask on a block with an image (D67, D71): the image is read as the reading
 * reads it, once per file; a block whose image cannot be read now is not
 * sent and not recorded; a private block loads nothing.
 */
import { describe, expect, test } from "bun:test";
import { Effect, Either } from "effect";
import { dailyNoteBlocks, imageReads } from "@/db/schema";
import { bytesToBase64 } from "@/lib/base64";
import { localDate } from "@/lib/dates";
import { imagesOf, type Scripted } from "@/services/llm/test";
import { readThread } from "@/test/helpers";
import { intakeTestLayer, out } from "@/test/intake-layer";
import { syncOnce } from "@/test/seed";
import { query } from "../db";
import { DailyNote, type DailyNoteShape } from ".";
import { hashText, normaliseBlock } from "./blocks";
import { imageKey } from "./test";

const home = {
  smallAsks: {
    projectKey: "OPS",
    label: "small-ask",
    joinActiveSprint: true,
    hintDismissed: false,
    defaultPoints: null,
  },
};
const ask = (summary: string) => ({
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
      rationale: "Dana asked",
      evidence: "the Q3 numbers",
      confidence: 0.9,
    },
  ],
});
const CHAT = "Dana (10:02): can you send me the Q3 numbers by Friday?";
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 7]);
const hashOf = (text: string) => hashText(normaliseBlock(text));
const rows = query((d) => d.select().from(dailyNoteBlocks).all());
const reads = query((d) => d.select().from(imageReads).all());

async function withNote<A>(
  scripts: Record<string, Scripted[]>,
  body: (note: DailyNoteShape, today: string) => Effect.Effect<A, unknown, unknown>,
) {
  const { layer, models, noteFile } = intakeTestLayer(scripts, [], { settings: home });
  noteFile.images.set(imageKey(null, "chat.png"), {
    mime: "image/png",
    data: bytesToBase64(png),
  });
  const r = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        yield* syncOnce;
        return yield* body(yield* DailyNote, localDate());
      }) as Effect.Effect<A, unknown, never>,
      layer,
    ),
  );
  return { r, models, noteFile };
}

describe("Ask on a block with an image (D71)", () => {
  test("the image is transcribed and the thread reads it as the quote", async () => {
    const block = "ask Dana about this\n![[chat.png]]";
    const { r, models } = await withNote(
      {
        "std-m": [
          out({ kind: "chat", text: CHAT, description: "A Teams chat with Dana." }),
          out(ask("Send Dana the Q3 numbers")),
        ],
      },
      (note, today) =>
        Effect.gen(function* () {
          yield* note.save(today, `${block}\n`);
          const asked = yield* note.ask(today, hashOf(block));
          return {
            thread: yield* readThread(asked.inboxItemId),
            rows: yield* rows,
            reads: yield* reads,
          };
        }),
    );
    expect(models.calls.filter((c) => imagesOf(c).length)).toHaveLength(1);
    expect(r.reads).toHaveLength(1);
    expect(r.thread.messages[0]?.content).toMatchObject({
      source: "note",
      parts: [
        { type: "typed", text: "ask Dana about this\n" },
        { type: "pasted", text: `[Image: chat.png: A Teams chat with Dana.]\n${CHAT}` },
      ],
    });
    expect(r.thread.props.map((p) => p.kind)).toEqual(["create_issue"]);
    expect(r.rows.map((b) => [b.text, b.status])).toEqual([[block, "acted"]]);
  });

  test("an image that cannot be read now: Ask says why and records nothing", async () => {
    const block = "look at this\n![[gone.png]]";
    const { r, models } = await withNote({}, (note, today) =>
      Effect.gen(function* () {
        yield* note.save(today, `${block}\n`);
        const asked = yield* Effect.either(note.ask(today, hashOf(block)));
        return { asked, rows: yield* rows };
      }),
    );
    expect(Either.isLeft(r.asked)).toBe(true);
    const error = Either.isLeft(r.asked) ? r.asked.left : null;
    expect(error).toMatchObject({ _tag: "NoteError", kind: "unavailable" });
    expect((error as { message: string }).message).toContain("image not found: gone.png");
    expect(r.rows).toHaveLength(0);
    expect(models.calls).toHaveLength(0);
  });

  test("a private block loads no image", async () => {
    const block = "salary letter\n![[chat.png]]";
    const { r, noteFile, models } = await withNote({}, (note, today) =>
      Effect.gen(function* () {
        yield* note.save(today, `## Private\n${block}\n`);
        return yield* Effect.either(note.ask(today, hashOf(block)));
      }),
    );
    expect(Either.isLeft(r) && r.left).toMatchObject({ kind: "private" });
    expect(noteFile.loads).toEqual([]);
    expect(models.calls).toHaveLength(0);
  });
});

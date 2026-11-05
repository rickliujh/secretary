/**
 * Reading the note's images (D71) over the `NoteFile` fake and a scripted
 * model: once per file, the caps and why a block waits.
 */
import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { imageReads } from "@/db/schema";
import { bytesToBase64 } from "@/lib/base64";
import { query } from "@/services/db";
import { DbTest } from "@/services/db/test";
import { LlmLive } from "@/services/llm/live";
import { imagesOf, makeScriptedModels, type Scripted } from "@/services/llm/test";
import { makeSecretsTest } from "@/services/secrets/test";
import { defaultSettings } from "@/services/settings/schema";
import { makeSettingsTest } from "@/services/settings/test";
import { testProvider } from "@/test/helpers";
import { out } from "@/test/intake-layer";
import { NoteFile } from ".";
import {
  IMAGES_PER_BLOCK,
  NO_VISION,
  NOT_RUNNING,
  prepareBlock,
  readImages,
  readingBudget,
} from "./image-reads";
import { imageLinks } from "./images";
import { imageKey, makeNoteFileTest } from "./test";

const png = (n: number, size = 9) => {
  const b = new Uint8Array(size);
  b.set([137, 80, 78, 71, 13, 10, 26, 10]);
  b[size - 1] = n;
  return b;
};
const read = (text: string, description = "A chat.") => out({ kind: "chat", text, description });

function setup(scripts: Record<string, Scripted[]>, files: Record<string, Uint8Array>) {
  const models = makeScriptedModels(scripts);
  const noteFile = makeNoteFileTest({ Work: null });
  for (const [name, data] of Object.entries(files))
    noteFile.images.set(imageKey("Work", name), { mime: "image/png", data: bytesToBase64(data) });
  const layer = Layer.mergeAll(
    Layer.provideMerge(
      LlmLive,
      Layer.mergeAll(
        makeSettingsTest({
          ...defaultSettings(),
          providers: [testProvider],
          tiers: { fast: null, standard: { providerId: "p1", model: "std-m" }, strong: null },
        }),
        makeSecretsTest({}),
        DbTest,
        models.layer,
      ),
    ),
    noteFile.layer,
  );
  const run = <A, E>(e: Effect.Effect<A, E, never>) => Effect.runPromise(e);
  return {
    models,
    noteFile,
    run: <A, E, R>(e: Effect.Effect<A, E, R>) =>
      run(Effect.provide(e, layer) as Effect.Effect<A, E, never>),
  };
}

const rows = query((d) => d.select().from(imageReads).all());

describe("readImages (D71)", () => {
  test("a file is transcribed once; the same bytes under another name reuse it", async () => {
    const { run, models } = setup(
      { "std-m": [read("Dana (10:02): the numbers?")] },
      { "a.png": png(1), "b.png": png(1) },
    );
    const r = await run(
      Effect.gen(function* () {
        const budget = readingBudget();
        const first = yield* readImages("Work", imageLinks("![[a.png]]"), budget);
        const second = yield* readImages("Work", imageLinks("![[b.png]]"), budget);
        return { first, second, budget, rows: yield* rows };
      }),
    );
    expect(r.first[0]).toMatchObject({
      status: "read",
      cached: false,
      transcript: { kind: "chat", text: "Dana (10:02): the numbers?", description: "A chat." },
    });
    expect(r.second[0]).toMatchObject({ status: "read", cached: true });
    expect(r.budget.calls).toBe(7);
    expect(models.calls).toHaveLength(1);
    expect(imagesOf(models.calls[0])[0]?.mediaType).toBe("image/png");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ name: "a.png", promptVersion: 1, model: "std-m" });
    expect(r.rows[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("Obsidian closed, a missing file, a refusing model, no budget: each waits with its reason", async () => {
    const { run, noteFile } = setup(
      { "std-m": [{ status: 400, body: '{"error":"image input is not supported"}' }] },
      { "a.png": png(1), "b.png": png(2) },
    );
    const r = await run(
      Effect.gen(function* () {
        const one = (link: string, budget = readingBudget()) =>
          readImages("Work", imageLinks(link), budget);
        const missing = yield* one("![[gone.png]]");
        const refused = yield* one("![[a.png]]");
        const noBudget = yield* one("![[b.png]]", { calls: 0, retryFailed: false });
        noteFile.state.running = false;
        const closed = yield* one("![[a.png]]");
        return { missing, refused, noBudget, closed };
      }),
    );
    expect(r.missing[0]).toMatchObject({
      status: "wait",
      reason: "not_found",
      message: "image not found: gone.png",
    });
    expect(r.refused[0]).toMatchObject({ status: "wait", reason: "model", message: NO_VISION });
    expect(r.noBudget[0]).toMatchObject({ status: "wait", reason: "cap" });
    expect(r.closed[0]).toMatchObject({
      status: "wait",
      reason: "not_running",
      message: NOT_RUNNING,
    });
    // Loading never starts Obsidian.
    expect(noteFile.launches.every((l) => l === false)).toBe(true);
  });

  test("an image too large to send waits; other model errors keep their words", async () => {
    const { run } = setup(
      { "std-m": [{ status: 500, body: "overloaded" }] },
      { "big.png": png(1, 4 * 1024 * 1024), "a.png": png(2) },
    );
    const r = await run(
      Effect.gen(function* () {
        const big = yield* readImages("Work", imageLinks("![[big.png]]"), readingBudget());
        const failed = yield* readImages("Work", imageLinks("![[a.png]]"), readingBudget());
        return { big, failed, rows: yield* rows };
      }),
    );
    expect(r.big[0]).toMatchObject({ status: "wait", reason: "too_large" });
    expect(r.failed[0]).toMatchObject({ status: "wait", reason: "model" });
    expect((r.failed[0] as { message: string }).message).toContain("a.png could not be read");
    // The failure is kept by the file's hash, with no transcript.
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ name: "a.png", text: "", attempts: 1, model: "std-m" });
    expect(r.rows[0]?.error).toContain("a.png could not be read");
  });

  test("a failed transcription is not sent again by a pass, only by Read now, Ask or six hours on", async () => {
    const { run, models } = setup(
      {
        "std-m": [
          { status: 400, body: "Could not process image" },
          { status: 400, body: "Could not process image" },
          read("Dana (10:02): the numbers?"),
        ],
      },
      { "a.png": png(1) },
    );
    const link = imageLinks("![[a.png]]");
    const r = await run(
      Effect.gen(function* () {
        const first = yield* readImages("Work", link, readingBudget());
        const pass = yield* readImages("Work", link, readingBudget());
        const callsAfterPass = models.calls.length;
        const button = yield* readImages("Work", link, readingBudget(true));
        const rowAfterButton = (yield* rows)[0];
        const later = yield* readImages(
          "Work",
          link,
          readingBudget(),
          new Date(Date.now() + 6 * 60 * 60 * 1000 + 1000),
        );
        return { first, pass, callsAfterPass, button, rowAfterButton, later, rows: yield* rows };
      }),
    );
    // A 400 that only mentions an image is not a model without vision.
    expect(r.first[0]).toMatchObject({ status: "wait", reason: "model" });
    expect((r.first[0] as { message: string }).message).not.toBe(NO_VISION);
    expect(r.pass[0]).toMatchObject({ status: "wait", reason: "model" });
    expect(r.callsAfterPass).toBe(1);
    expect(r.button[0]).toMatchObject({ status: "wait", reason: "model" });
    expect(r.rowAfterButton).toMatchObject({ attempts: 2 });
    expect(r.later[0]).toMatchObject({ status: "read", cached: false });
    expect(models.calls).toHaveLength(3);
    expect(r.rows[0]).toMatchObject({ error: null, text: "Dana (10:02): the numbers?" });
  });

  test("a bmp cannot be sent without a decoder; a JPEG named .png goes as image/jpeg", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 9]);
    const { run, models } = setup({ "std-m": [read("ok")] }, {});
    const r = await run(
      Effect.gen(function* () {
        const file = yield* NoteFile;
        // The fake keeps every image as image/png, as a mislabelled file would come.
        yield* file.saveImage("Work", new Uint8Array([0x42, 0x4d, 1, 2]), "bmp");
        yield* file.saveImage("Work", jpeg, "png");
        const bmp = yield* readImages(
          "Work",
          imageLinks("![[Pasted image 1.bmp]]"),
          readingBudget(),
        );
        const named = yield* readImages(
          "Work",
          imageLinks("![[Pasted image 2.png]]"),
          readingBudget(),
        );
        return { bmp, named };
      }),
    );
    expect(r.bmp[0]).toMatchObject({
      status: "wait",
      reason: "unsupported",
      message: "Pasted image 1.bmp: unsupported image type",
    });
    expect(r.named[0]).toMatchObject({ status: "read" });
    expect(imagesOf(models.calls[0])[0]?.mediaType).toBe("image/jpeg");
  });
});

describe("prepareBlock (D71)", () => {
  test("no links: unchanged and nothing loaded; links: quoted, at most four, a repeat once", async () => {
    const { run, models, noteFile } = setup(
      {
        "std-m": Array.from({ length: IMAGES_PER_BLOCK }, (_, i) =>
          read(`text ${i + 1}`, `Image ${i + 1}.`),
        ),
      },
      Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`i${i + 1}.png`, png(i + 1)])),
    );
    const text =
      "look\n![[i1.png]]\n![[i1.png]] ![[i2.png]]\n![[i3.png]]\n![[i4.png]]\n![[i5.png]]";
    const r = await run(
      Effect.gen(function* () {
        const plain = yield* prepareBlock("Work", "just words", readingBudget());
        const loadsAfterPlain = noteFile.loads.length;
        const block = yield* prepareBlock("Work", text, readingBudget());
        return { plain, loadsAfterPlain, block };
      }),
    );
    expect(r.plain).toEqual({
      status: "ready",
      text: "just words",
      triageText: "just words",
      images: 0,
    });
    expect(r.loadsAfterPlain).toBe(0);
    expect(models.calls).toHaveLength(4);
    expect(r.block.status).toBe("ready");
    const ready = r.block as { text: string; images: number };
    expect(ready.images).toBe(4);
    expect(ready.text.split("\n")).toEqual([
      "look",
      "> [Image: i1.png: Image 1.]",
      "> text 1",
      "> [Image: i1.png: Image 1.]",
      "> text 1",
      "> [Image: i2.png: Image 2.]",
      "> text 2",
      "> [Image: i3.png: Image 3.]",
      "> text 3",
      "> [Image: i4.png: Image 4.]",
      "> text 4",
      "![[i5.png]]",
    ]);
  });

  test("the triage's text clips each transcript inside its quote; the full text keeps it", async () => {
    const long = Array.from({ length: 200 }, (_, i) => `Sam (10:${i % 60}): line ${i}`).join("\n");
    const { run } = setup({ "std-m": [read(long)] }, { "a.png": png(1) });
    const r = await run(
      prepareBlock("Work", "![[a.png]]\nplease answer Sam today", readingBudget()),
    );
    const ready = r as { text: string; triageText: string };
    expect(ready.text).toContain("line 199");
    expect(ready.text).not.toContain("[... clipped]");
    expect(ready.triageText).not.toContain("line 199");
    expect(ready.triageText).toContain("> [... clipped]\nplease answer Sam today");
    // 1 500 characters of transcript, each line quoted with "> ".
    expect(ready.triageText.length).toBeLessThan(2000);
  });

  test("one image that waits makes the whole block wait", async () => {
    const { run } = setup({ "std-m": [read("ok")] }, { "a.png": png(1) });
    const r = await run(prepareBlock("Work", "![[a.png]]\n![[gone.png]]", readingBudget()));
    expect(r).toEqual({
      status: "wait",
      reason: "not_found",
      message: "image not found: gone.png",
    });
  });
});

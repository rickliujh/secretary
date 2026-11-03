/** The chat's daily_note tool (FR-20.5, D65): "note this" appends, "what's in my note?" reads. */
import { describe, expect, test } from "bun:test";
import type { UIMessage, UIMessageChunk } from "ai";
import { Effect } from "effect";
import { localDate } from "@/lib/dates";
import { DailyNote } from "@/services/note";
import { defaultSettings } from "@/services/settings/schema";
import { drainStream, promptOf } from "@/test/helpers";
import { intakeTestLayer } from "@/test/intake-layer";
import { Chat } from ".";

const ask = (text: string): UIMessage[] => [
  { id: "u1", role: "user", parts: [{ type: "text", text }] },
];
const outputs = (chunks: UIMessageChunk[]) =>
  chunks.flatMap((c) => (c.type === "tool-output-available" ? [c.output] : [])) as Record<
    string,
    unknown
  >[];

async function turn(
  steps: { toolCall: { name: string; input: unknown } }[],
  question: string,
  opts: { body?: string; enabled?: boolean } = {},
) {
  const s = defaultSettings();
  const { layer, models } = intakeTestLayer({ "std-m": [...steps, { text: "Done." }] }, [], {
    settings: {
      secretary: {
        ...s.secretary,
        dailyNote: { ...s.secretary.dailyNote, enabled: opts.enabled ?? true },
      },
    },
  });
  let passes = 0;
  const r = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const note = yield* DailyNote;
        if (opts.body !== undefined) yield* note.save(localDate(), opts.body);
        const stream = yield* (yield* Chat).stream({
          messages: ask(question),
          onWorkChanged: () => {
            passes++;
          },
        });
        const chunks = yield* Effect.promise(() => drainStream(stream));
        return { chunks, body: (yield* note.load(localDate())).body };
      }),
      layer,
    ),
  );
  return { ...r, passes, models, out: outputs(r.chunks) };
}

describe("daily_note (FR-20.5)", () => {
  test("append adds the user's line to today's note and asks for a pass", async () => {
    const r = await turn(
      [{ toolCall: { name: "daily_note", input: { action: "append", text: "call the bank" } } }],
      "note this: call the bank",
      { body: "first line" },
    );
    expect(r.out[0]).toMatchObject({ appended: true, date: localDate() });
    expect(r.body).toBe("first line\ncall the bank\n");
    expect(r.passes).toBe(1);
    expect(promptOf(r.models.calls, 0)).toContain("call daily_note with append");
  });

  test("read returns today's note as the user's words", async () => {
    const r = await turn(
      [{ toolCall: { name: "daily_note", input: { action: "read" } } }],
      "what's in my note?",
      { body: "- [ ] send Dana the Q3 numbers\n" },
    );
    expect(r.out[0]).toMatchObject({
      date: localDate(),
      text: "- [ ] send Dana the Q3 numbers\n",
      lastRead: null,
    });
  });

  test("read leaves the private section out, so it reaches no model", async () => {
    const r = await turn(
      [{ toolCall: { name: "daily_note", input: { action: "read" } } }],
      "what's in my note?",
      { body: "call the bank\n\n## Private\nsalary review with HR\n\n## Work\nPAY-12 tests\n" },
    );
    expect(r.out[0]).toMatchObject({
      text: "call the bank\n\n## Work\nPAY-12 tests\n",
      privateLeftOut: true,
    });
    for (const c of r.models.calls) expect(JSON.stringify(c.prompt)).not.toContain("salary");
  });

  test("off in Settings: the tool says so and writes nothing", async () => {
    const r = await turn(
      [{ toolCall: { name: "daily_note", input: { action: "append", text: "x" } } }],
      "note this: x",
      { enabled: false },
    );
    expect(r.out[0]).toMatchObject({ error: expect.stringContaining("Settings > Secretary") });
    expect(r.body).toBe("");
  });
});

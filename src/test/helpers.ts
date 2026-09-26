/** Small helpers shared by service tests. */
import { asc, eq } from "drizzle-orm";
import { Effect } from "effect";
import { inboxItems, inboxMessages, intakeItems, proposals } from "@/db/schema";
import { query } from "@/services/db";
import { ProviderSchema } from "@/services/settings/schema";

/** The fixtures' "today": Payments 15 is the active sprint (2026-09-14 to 2026-09-28). */
export const TODAY = "2026-09-24";

/** One Anthropic-kind provider with every optional setting at its default. */
export const testProvider = ProviderSchema.parse({
  id: "p1",
  name: "Test",
  kind: "anthropic",
  baseUrl: "https://llm.test/v1",
});

/** The prompt of the i-th scripted model call, as a string to search. */
export const promptOf = (calls: readonly { prompt: unknown }[], i: number) =>
  JSON.stringify(calls[i]?.prompt);

/** An inbox thread as stored: the item, its messages, proposals and intake items, in order. */
export const readThread = (inboxItemId: string) =>
  Effect.gen(function* () {
    const item = yield* query((d) =>
      d.select().from(inboxItems).where(eq(inboxItems.id, inboxItemId)).get(),
    );
    const messages = yield* query((d) =>
      d
        .select()
        .from(inboxMessages)
        .where(eq(inboxMessages.inboxItemId, inboxItemId))
        .orderBy(asc(inboxMessages.seq))
        .all(),
    );
    const props = yield* query((d) =>
      d
        .select()
        .from(proposals)
        .where(eq(proposals.inboxItemId, inboxItemId))
        .orderBy(asc(proposals.seq))
        .all(),
    );
    const items = yield* query((d) =>
      d.select().from(intakeItems).where(eq(intakeItems.inboxItemId, inboxItemId)).all(),
    );
    return { item, messages, props, items };
  });

/** Read a stream to the end and return every chunk. */
export async function drainStream<T>(stream: ReadableStream<T>): Promise<T[]> {
  const chunks: T[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
}

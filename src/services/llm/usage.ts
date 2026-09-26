/** Token usage reporting over `llm_calls` (FR-9.5). */
import { desc, gte } from "drizzle-orm";
import { Effect } from "effect";
import { llmCalls } from "@/db/schema";
import { query } from "@/services/db";

export type UsageRow = Pick<
  typeof llmCalls.$inferSelect,
  "tier" | "inputTokens" | "outputTokens" | "ok"
>;

export type UsageSummary = {
  calls: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  byTier: Record<
    "fast" | "standard" | "strong" | "untiered",
    { calls: number; inputTokens: number; outputTokens: number }
  >;
};

export function summarizeUsage(rows: readonly UsageRow[]): UsageSummary {
  const empty = () => ({ calls: 0, inputTokens: 0, outputTokens: 0 });
  const summary: UsageSummary = {
    calls: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    byTier: { fast: empty(), standard: empty(), strong: empty(), untiered: empty() },
  };
  for (const row of rows) {
    const bucket = summary.byTier[row.tier ?? "untiered"];
    const input = row.inputTokens ?? 0;
    const output = row.outputTokens ?? 0;
    summary.calls += 1;
    if (!row.ok) summary.failed += 1;
    summary.inputTokens += input;
    summary.outputTokens += output;
    bucket.calls += 1;
    bucket.inputTokens += input;
    bucket.outputTokens += output;
  }
  return summary;
}

export const usageSince = (since: string) =>
  query((db) =>
    db
      .select({
        tier: llmCalls.tier,
        inputTokens: llmCalls.inputTokens,
        outputTokens: llmCalls.outputTokens,
        ok: llmCalls.ok,
      })
      .from(llmCalls)
      .where(gte(llmCalls.at, since))
      .all(),
  ).pipe(Effect.map(summarizeUsage));

export const recentCalls = (limit = 50) =>
  query((db) => db.select().from(llmCalls).orderBy(desc(llmCalls.at)).limit(limit).all());

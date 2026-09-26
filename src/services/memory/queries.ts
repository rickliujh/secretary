/** The Memory page (FR-7.1, FR-7.5): the user's own edits are direct writes (D17). */
import { desc, eq } from "drizzle-orm";
import { Effect } from "effect";
import { memories, people, teams } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { query } from "@/services/db";
import { describePayload, ProposalPayloadSchema } from "@/services/proposals/schema";
import { type MemoryInput, MemoryInputSchema } from "./schema";

export * from "./schema";

const describe = (value: unknown): string => {
  if (Array.isArray(value)) return value.map(describe).join("; ") || "nothing";
  const r = ProposalPayloadSchema.safeParse(value);
  return r.success ? describePayload(r.data) : "";
};

export type MemoryView = {
  id: string;
  kind: "rule" | "fact" | "preference" | "example";
  content: string;
  subjectType: string | null;
  subjectId: string | null;
  /** A readable name for the subject: contact, team, issue key or proposal kind. */
  subjectLabel: string | null;
  source: "user" | "inferred";
  sourceInboxItemId: string | null;
  confirmed: boolean;
  weight: number;
  useCount: number;
  lastUsedAt: string | null;
  createdAt: string;
  example: { input: string; before: string; after: string | null } | null;
};

export const listMemories = Effect.gen(function* () {
  const rows = yield* query((d) =>
    d.select().from(memories).orderBy(desc(memories.createdAt)).all(),
  );
  const personName = new Map(
    (yield* query((d) =>
      d.select({ id: people.id, name: people.displayName }).from(people).all(),
    )).map((p) => [p.id, p.name]),
  );
  const teamName = new Map(
    (yield* query((d) => d.select({ id: teams.id, name: teams.name }).from(teams).all())).map(
      (t) => [t.id, t.name],
    ),
  );
  return rows.map(
    (m): MemoryView => ({
      id: m.id,
      kind: m.kind,
      content: m.content,
      subjectType: m.subjectType,
      subjectId: m.subjectId,
      subjectLabel:
        m.subjectType === "person"
          ? (personName.get(m.subjectId ?? "") ?? "a removed contact")
          : m.subjectType === "team"
            ? (teamName.get(m.subjectId ?? "") ?? "a removed team")
            : m.subjectType === "issue"
              ? m.subjectId
              : m.subjectType === "proposal_kind"
                ? (m.subjectId ?? "").replace("_", " ")
                : m.subjectType === "revision"
                  ? "a requested change"
                  : null,
      source: m.source,
      sourceInboxItemId: m.sourceInboxItemId,
      confirmed: m.confirmed,
      weight: m.weight,
      useCount: m.useCount,
      lastUsedAt: m.lastUsedAt,
      createdAt: m.createdAt,
      example:
        m.kind === "example"
          ? {
              input: m.exampleInput ?? "",
              before: describe(m.exampleBefore),
              after: m.exampleAfter === null ? null : describe(m.exampleAfter),
            }
          : null,
    }),
  );
});

export const createMemory = (input: MemoryInput) =>
  Effect.gen(function* () {
    const v = MemoryInputSchema.parse(input);
    const id = newId();
    yield* query((d) =>
      d.insert(memories).values({ id, ...v, source: "user", confirmed: true, createdAt: nowIso() }),
    );
    return id;
  });

export const updateMemory = (id: string, input: MemoryInput) =>
  Effect.gen(function* () {
    const v = MemoryInputSchema.parse(input);
    yield* query((d) => d.update(memories).set(v).where(eq(memories.id, id)));
  });

export const setWeight = (id: string, weight: number) =>
  query((d) => d.update(memories).set({ weight }).where(eq(memories.id, id)));

/** FR-7.5: an inferred memory counts only once the user confirms it. */
export const setConfirmed = (id: string, confirmed: boolean) =>
  query((d) => d.update(memories).set({ confirmed }).where(eq(memories.id, id)));

export const deleteMemory = (id: string) =>
  query((d) => d.delete(memories).where(eq(memories.id, id)));

import { Effect, Layer } from "effect";
import { actionsLog } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { logger } from "@/lib/log";
import { redactValue } from "@/lib/redact";
import { Db, query } from "@/services/db";
import { JiraClient } from "@/services/jira";
import { Sync } from "@/services/sync";
import { describeAction, Executor, ExecutorError, JiraActionSchema } from ".";
import { buildJiraWrite, MappingError } from "./jira-mapping";

const make = Effect.gen(function* () {
  const jira = yield* JiraClient;
  const sync = yield* Sync;
  const db = yield* Db;

  const log = (row: Omit<typeof actionsLog.$inferInsert, "id" | "at">) =>
    Effect.gen(function* () {
      const id = newId();
      yield* query((d) =>
        d.insert(actionsLog).values({
          ...row,
          id,
          request: redactValue(row.request),
          response: redactValue(row.response),
          at: nowIso(),
        }),
      ).pipe(Effect.provideService(Db, db));
      return id;
    });

  return Executor.of({
    run: (input, opts = {}) =>
      Effect.gen(function* () {
        const parsed = JiraActionSchema.safeParse(input);
        if (!parsed.success) {
          return yield* new ExecutorError({
            kind: "invalid",
            message: parsed.error.issues.map((i) => i.message).join("; "),
          });
        }
        const action = parsed.data;
        const { effective: fieldIds } = yield* sync.fieldInfo;
        const editMeta =
          action.kind === "set_epic" ? yield* jira.getEditMeta(action.issueKey) : undefined;
        const request = yield* Effect.try({
          try: () => buildJiraWrite(action, { fieldIds, editMeta }),
          catch: (e) =>
            new ExecutorError({
              kind: e instanceof MappingError ? "unsupported" : "invalid",
              message: e instanceof Error ? e.message : String(e),
            }),
        });

        const response = yield* jira.send(request).pipe(
          Effect.tapError((e) =>
            log({
              proposalId: opts.proposalId ?? null,
              action: action.kind,
              target: action.issueKey,
              request,
              response: { error: e.message, status: e.status ?? null },
              ok: false,
            }).pipe(Effect.catchAll(() => Effect.void)),
          ),
        );
        const actionLogId = yield* log({
          proposalId: opts.proposalId ?? null,
          action: action.kind,
          target: action.issueKey,
          request,
          response,
          ok: true,
        });
        logger.info(`${describeAction(action)}: done`);

        // Show Jira's truth after every write (design.md 7.3).
        const refreshed = yield* sync.refreshIssue(action.issueKey).pipe(
          Effect.as(true),
          Effect.catchAll((e) =>
            Effect.sync(() => {
              logger.warn(`Re-fetch of ${action.issueKey} failed`, e.message);
              return false;
            }),
          ),
        );
        return { actionLogId, response, refreshed };
      }),
  });
});

export const ExecutorLive = Layer.effect(Executor, make);

import { inArray } from "drizzle-orm";
import { Effect, Layer } from "effect";
import { inboxItems, inboxMessages, jiraIssues, proposals } from "@/db/schema";
import { localDate } from "@/lib/dates";
import { newId, nowIso } from "@/lib/ids";
import {
  buildPlanPrompt,
  buildPlanSchema,
  type PlanContext,
  type PlanOutput,
  validatePlan,
} from "@/prompts/plan";
import { loadDashboardInputs } from "@/services/dashboard/data";
import { rank } from "@/services/dashboard/scoring";
import { blockInfo } from "@/services/dashboard/sections";
import { bindDb, Db } from "@/services/db";
import { timing } from "@/services/dependencies/logic";
import { Llm } from "@/services/llm";
import type { ProposalPayload } from "@/services/proposals/schema";
import { Settings, settingsOrDefault } from "@/services/settings";
import type { SprintInfo } from "@/services/sprints/calendar";
import { getState, parseSprintState, SYNC_KEYS } from "@/services/sync/state";
import {
  buildCandidates,
  type PlanIssue,
  Planning,
  PlanningError,
  type PlanPrep,
  type PlanToPropose,
  pointsOf,
  type SprintRef,
  sprintPair,
  velocity,
} from ".";

const ref = (s: SprintInfo | null): SprintRef | null =>
  s ? { id: s.id, name: s.name, start: s.start, end: s.end } : null;

const make = Effect.gen(function* () {
  const db = yield* Db;
  const llm = yield* Llm;
  const settingsSvc = yield* Settings;
  const { q, withDb } = bindDb(db);

  /** Sprint pair, velocity and candidates from the cache (design.md D30). */
  const prepare = (today = localDate()) =>
    Effect.gen(function* () {
      const settings = yield* settingsOrDefault(settingsSvc);
      const me = yield* withDb(getState(SYNC_KEYS.username));
      if (!me)
        return yield* new PlanningError({
          kind: "no_user",
          message: "Sync Jira first so the planner knows which work is yours.",
        });
      const inputs = yield* withDb(loadDashboardInputs()).pipe(
        Effect.provideService(Settings, settingsSvc),
      );
      const sprints = parseSprintState(yield* withDb(getState(SYNC_KEYS.sprints))).sprints;
      // Points and resolution dates are not part of the dashboard's view.
      const extra = new Map(
        (yield* q((d) =>
          d
            .select({
              key: jiraIssues.key,
              storyPoints: jiraIssues.storyPoints,
              resolved: jiraIssues.resolved,
            })
            .from(jiraIssues)
            .where(
              inArray(
                jiraIssues.key,
                inputs.issues.map((i) => i.key),
              ),
            )
            .all(),
        )).map((r) => [r.key, r]),
      );
      const openDeps = inputs.dependencies.filter((d) => d.status !== "resolved");
      const depsOf = (key: string) =>
        openDeps
          .filter((d) => d.issueKey === key)
          .map((d) => ({ ...d, overdueDays: timing(d, today).overdueDays }));
      // Same ranking as Top focus, so the backlog order matches the dashboard.
      const scores = new Map(
        rank(
          inputs.issues
            .filter((i) => i.statusCategory !== "done")
            .map((i) => {
              const b = blockInfo(i.links);
              return {
                key: i.key,
                priority: i.priority,
                dueDate: i.dueDate,
                updated: i.updated,
                statusName: i.status,
                blockedBy: b.blockedBy,
                blocks: b.blocks,
                dependencies: depsOf(i.key),
                pinned: i.pinned,
                override: i.priorityOverride,
              };
            }),
          settings.scoring,
          today,
        ).map((s) => [s.key, s.score]),
      );
      const issues: PlanIssue[] = inputs.issues.map((i) => ({
        key: i.key,
        summary: i.summary,
        issueType: i.issueType,
        status: i.status,
        statusCategory: i.statusCategory,
        priority: i.priority,
        storyPoints: extra.get(i.key)?.storyPoints ?? null,
        assignee: i.assignee,
        epicKey: i.epicKey,
        sprint: i.sprint,
        dueDate: i.dueDate,
        resolved: extra.get(i.key)?.resolved ?? null,
        blockedBy: blockInfo(i.links).blockedBy,
        waitingOn: depsOf(i.key).map((d) => ({ label: d.label, expectedAt: d.expectedAt })),
        score: scores.get(i.key) ?? 0,
      }));

      const { active, next } = sprintPair(sprints, issues, me);
      const vel = velocity(sprints, issues, me, active?.boardId ?? null);
      const inEnding = active
        ? issues.filter((i) => i.assignee === me && i.sprint === active.name)
        : [];
      return {
        ending: ref(active),
        next: ref(next),
        endingSummary: active
          ? {
              committed: inEnding.reduce((n, i) => n + (i.storyPoints ?? 0), 0),
              done: inEnding
                .filter((i) => i.statusCategory === "done")
                .reduce((n, i) => n + (i.storyPoints ?? 0), 0),
              open: inEnding.filter((i) => i.statusCategory !== "done").length,
              unestimated: inEnding.filter((i) => i.storyPoints === null).length,
            }
          : null,
        velocity: vel,
        capacity: vel.average,
        candidates: buildCandidates({
          issues,
          me,
          active,
          next,
          trackedEpics: settings.jira.trackedEpics,
        }),
      } satisfies PlanPrep;
    });

  const draft: Planning["Type"]["draft"] = ({ capacity, instructions, today = localDate() }) =>
    Effect.gen(function* () {
      const prep = yield* prepare(today);
      if (prep.candidates.length === 0)
        return yield* new PlanningError({
          kind: "no_candidates",
          message: "Nothing to plan: you have no open work in the ending sprint or your backlog.",
        });
      const ctx: PlanContext = {
        today,
        next: prep.next,
        ending: prep.ending,
        capacity,
        velocity: prep.velocity,
        candidates: prep.candidates,
        instructions: instructions.map((x) => x.trim()).filter(Boolean),
      };
      const { value } = yield* llm.object<PlanOutput>("plan_sprint", {
        schema: buildPlanSchema(prep.candidates.map((c) => c.key)) as never,
        ...buildPlanPrompt(ctx),
        validate: (out) => validatePlan(out, ctx),
      });
      const { total, unestimated } = pointsOf(
        prep.candidates,
        value.picks.map((p) => p.key),
      );
      return { prep, plan: { ...value, points: total, unestimated } };
    });

  const propose = (plan: PlanToPropose) =>
    Effect.gen(function* () {
      const prep = yield* prepare();
      const next = prep.next;
      if (!next)
        return yield* new PlanningError({
          kind: "no_sprint",
          message:
            "The next sprint does not exist in Jira yet. Create it on the board, sync, then send the plan again.",
        });
      const byKey = new Map(prep.candidates.map((c) => [c.key, c]));
      const picks = [...new Set(plan.picks)].filter((k) => byKey.has(k));
      const alreadyThere = picks.filter((k) => byKey.get(k)?.group === "planned");
      const moves = picks.filter((k) => !alreadyThere.includes(k));

      const inboxItemId = newId();
      const messageId = newId();
      const now = nowIso();
      const title = `Plan for ${next.name}`;
      const summary = [
        plan.goal.trim() ? `Goal: ${plan.goal.trim()}` : title,
        plan.deferred.length
          ? `Deferred: ${plan.deferred.map((d) => `${d.key} (${d.reason})`).join("; ")}`
          : null,
        plan.risks.length ? `Risks: ${plan.risks.join("; ")}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      yield* q((d) =>
        d.insert(inboxItems).values({
          id: inboxItemId,
          source: "other",
          senderPersonId: null,
          rawText: title,
          receivedAt: now,
          status: moves.length ? "triaged" : "filed",
          summary: plan.goal.trim() ? `${title}: ${plan.goal.trim()}` : title,
          triage: { items: 0, proposals: moves.length, questions: 0, at: now },
        }),
      );
      yield* q((d) =>
        d.insert(inboxMessages).values([
          {
            id: newId(),
            inboxItemId,
            seq: 0,
            role: "user",
            content: {
              parts: [{ type: "typed", text: `${title} (${picks.length} tickets)` }],
              source: "other",
              origin: "planner",
            },
            createdAt: now,
          },
          {
            id: messageId,
            inboxItemId,
            seq: 1,
            role: "assistant",
            content: { summary },
            createdAt: now,
          },
        ]),
      );
      if (moves.length)
        yield* q((d) =>
          d.insert(proposals).values(
            moves.map((key, seq) => {
              const payload: ProposalPayload = {
                kind: "move_to_sprint",
                target: key,
                sprintId: next.id,
                sprintName: next.name,
              };
              return {
                id: newId(),
                inboxItemId,
                intakeItemId: null,
                messageId,
                seq,
                kind: "move_to_sprint",
                payload,
                rationale: plan.goal.trim()
                  ? `For ${next.name}: ${plan.goal.trim()}`
                  : `For ${next.name}`,
                evidence: null,
                confidence: null,
                status: "pending" as const,
                createdAt: now,
              };
            }),
          ),
        );
      return { inboxItemId, proposals: moves.length, alreadyThere };
    });

  return Planning.of({ prepare, draft, propose });
});

export const PlanningLive = Layer.effect(Planning, make);

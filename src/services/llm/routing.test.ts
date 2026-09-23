import { describe, expect, test } from "bun:test";
import { defaultSettings, type TierBindings } from "@/services/settings/schema";
import { escalationTarget, resolveTask, resolveTier } from "./routing";
import { TASK_DEFAULTS, TASK_TYPES, TIERS } from "./tasks";

const bind = (model: string) => ({ providerId: "p1", model });
const withTiers = (tiers: Partial<TierBindings>) => ({
  ...defaultSettings(),
  tiers: { fast: null, standard: null, strong: null, ...tiers },
});

describe("tier resolution", () => {
  test("with only one tier configured, every task resolves to it", () => {
    for (const only of TIERS) {
      const s = withTiers({ [only]: bind(`m-${only}`) });
      for (const task of TASK_TYPES) {
        expect(resolveTask(s, task).resolved?.tier).toBe(only);
      }
    }
  });

  test("with three tiers configured, each task resolves to its default", () => {
    const s = withTiers({ fast: bind("f"), standard: bind("s"), strong: bind("x") });
    for (const task of TASK_TYPES) {
      expect(resolveTask(s, task).resolved?.tier).toBe(TASK_DEFAULTS[task].tier);
    }
    expect(resolveTask(s, "segment_input").resolved?.binding.model).toBe("f");
    expect(resolveTask(s, "classify_item").resolved?.binding.model).toBe("s");
    expect(resolveTask(s, "consolidate_rules").resolved?.binding.model).toBe("x");
  });

  test("an unconfigured tier falls back to the next stronger one first", () => {
    const tiers = { fast: bind("f"), standard: null, strong: bind("x") };
    expect(resolveTier(tiers, "standard")?.tier).toBe("strong");
  });

  test("then to weaker tiers when nothing stronger exists", () => {
    const tiers = { fast: bind("f"), standard: bind("s"), strong: null };
    expect(resolveTier(tiers, "strong")?.tier).toBe("standard");
  });

  test("no configured tier resolves to undefined", () => {
    expect(resolveTask(withTiers({}), "classify_item").resolved).toBeUndefined();
  });

  test("per-task overrides change tier and escalation", () => {
    const s = {
      ...withTiers({ fast: bind("f"), standard: bind("s"), strong: bind("x") }),
      taskOverrides: { classify_item: { tier: "strong" as const, escalate: false } },
    };
    const route = resolveTask(s, "classify_item");
    expect(route.requestedTier).toBe("strong");
    expect(route.resolved?.binding.model).toBe("x");
    expect(route.escalate).toBe(false);
  });
});

describe("escalation target", () => {
  test("is the next stronger configured tier", () => {
    const tiers = { fast: bind("f"), standard: bind("s"), strong: bind("x") };
    expect(escalationTarget(tiers, { tier: "fast", binding: bind("f") })?.tier).toBe("standard");
    expect(escalationTarget(tiers, { tier: "standard", binding: bind("s") })?.tier).toBe("strong");
    expect(escalationTarget(tiers, { tier: "strong", binding: bind("x") })).toBeUndefined();
  });

  test("skips tiers bound to the same model", () => {
    const tiers = { fast: bind("s"), standard: bind("s"), strong: bind("x") };
    expect(escalationTarget(tiers, { tier: "fast", binding: bind("s") })?.binding.model).toBe("x");
  });

  test("is undefined for a single configured model", () => {
    const tiers = { fast: null, standard: bind("s"), strong: null };
    expect(escalationTarget(tiers, { tier: "standard", binding: bind("s") })).toBeUndefined();
  });
});

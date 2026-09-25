/**
 * Non-secret application settings persisted in the plugin-store file.
 * Secrets (PATs, API keys, provider headers) live in the keychain only.
 */
import { z } from "zod";
import { TASK_TYPES, TIERS } from "@/services/llm/tasks";

const optionalUrl = z.union([z.literal(""), z.url({ protocol: /^https?$/ })]);

export const ProviderKind = z.enum(["anthropic", "openai-compatible"]);
export type ProviderKind = z.infer<typeof ProviderKind>;

export const ProviderSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1, "Name is required"),
  kind: ProviderKind,
  baseUrl: z.url({ protocol: /^https?$/, error: "Enter an http(s) URL" }),
  /** Names of extra headers whose values are in the keychain (design.md D12). */
  headerNames: z.array(z.string()).default([]),
  // Anthropic-compatible options. Proxies may reject thinking/effort, so both are opt-in.
  authStyle: z.enum(["x-api-key", "bearer"]).default("x-api-key"),
  thinking: z.enum(["default", "adaptive", "disabled"]).default("default"),
  effort: z.enum(["default", "low", "medium", "high", "xhigh", "max"]).default("default"),
  structuredOutputMode: z.enum(["auto", "outputFormat", "jsonTool"]).default("auto"),
  // OpenAI-compatible options.
  jsonSchemaOutputs: z.boolean().default(true),
  sendTemperature: z.boolean().default(true),
  seed: z.number().int().optional(),
});
export type Provider = z.infer<typeof ProviderSchema>;

export const TierBindingSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().trim().min(1),
});
export type TierBinding = z.infer<typeof TierBindingSchema>;

const TierEnum = z.enum(TIERS);

export const TaskOverrideSchema = z.object({
  tier: TierEnum.optional(),
  escalate: z.boolean().optional(),
});
export type TaskOverride = z.infer<typeof TaskOverrideSchema>;

export const DEFAULT_JQL =
  "(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND updated >= -90d";

const JiraSettingsSchema = z.object({
  baseUrl: optionalUrl.default(""),
  jql: z.string().default(DEFAULT_JQL),
  trackedEpics: z.array(z.string()).default([]),
  syncIntervalMinutes: z.number().int().min(1).max(1440).default(10),
  /** Manual overrides for discovered custom field ids (FR-1.4). */
  fields: z
    .object({
      epicLink: z.string().optional(),
      epicName: z.string().optional(),
      sprint: z.string().optional(),
    })
    .default({}),
});

const ConfluenceSettingsSchema = z.object({
  baseUrl: optionalUrl.default(""),
});

/** Top-focus ranking weights (FR-5.2); each factor is scaled 0..1 before weighting. */
export const ScoringWeightsSchema = z.object({
  priority: z.number().min(0).max(20).default(3),
  due: z.number().min(0).max(20).default(4),
  blocked: z.number().min(0).max(20).default(2),
  blocking: z.number().min(0).max(20).default(2),
  stale: z.number().min(0).max(20).default(1),
  dependency: z.number().min(0).max(20).default(3),
  pinned: z.number().min(0).max(50).default(10),
});
export type ScoringWeights = z.infer<typeof ScoringWeightsSchema>;
export const DEFAULT_WEIGHTS: ScoringWeights = ScoringWeightsSchema.parse({});

export const SettingsSchema = z.object({
  version: z.literal(1).default(1),
  providers: z.array(ProviderSchema).default([]),
  tiers: z
    .object({
      fast: TierBindingSchema.nullable().default(null),
      standard: TierBindingSchema.nullable().default(null),
      strong: TierBindingSchema.nullable().default(null),
    })
    .default({ fast: null, standard: null, strong: null }),
  taskOverrides: z.partialRecord(z.enum(TASK_TYPES), TaskOverrideSchema).default({}),
  jira: JiraSettingsSchema.default(JiraSettingsSchema.parse({})),
  confluence: ConfluenceSettingsSchema.default({ baseUrl: "" }),
  general: z
    .object({
      outputLanguage: z.string().trim().min(1).default("English"),
    })
    .default({ outputLanguage: "English" }),
  dependencies: z
    .object({
      /** Working days until the next follow-up after one is logged. */
      followupDays: z.number().int().min(1).max(30).default(3),
      /** OS notifications when a follow-up is due (FR-3.5). */
      reminders: z.boolean().default(true),
    })
    .default({ followupDays: 3, reminders: true }),
  scoring: ScoringWeightsSchema.default(DEFAULT_WEIGHTS),
  network: z
    .object({
      /**
       * "system": HTTPS_PROXY/HTTP_PROXY variables and the manual macOS/Windows proxy.
       * PAC (automatic configuration) files are not evaluated, so PAC users pick
       * "manual" and enter the proxy the PAC file returns.
       */
      proxyMode: z.enum(["system", "manual"]).default("system"),
      proxyUrl: z.union([z.literal(""), z.url({ protocol: /^(https?|socks5h?)$/ })]).default(""),
      /** Comma-separated hosts that bypass the proxy, e.g. "localhost,127.0.0.1,.internal". */
      noProxy: z.string().default("localhost,127.0.0.1"),
      /** Proxy login; the password is in the keychain. */
      proxyUsername: z.string().default(""),
    })
    .default({
      proxyMode: "system",
      proxyUrl: "",
      noProxy: "localhost,127.0.0.1",
      proxyUsername: "",
    }),
});

export type AppSettings = z.infer<typeof SettingsSchema>;
export type TierBindings = AppSettings["tiers"];

export const defaultSettings = (): AppSettings => SettingsSchema.parse({});

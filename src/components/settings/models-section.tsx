import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { useErrorToast, useSettings, useUpdateSettings } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Llm } from "@/services/llm";
import { resolveTask } from "@/services/llm/routing";
import {
  ANTHROPIC_MODEL_SUGGESTIONS,
  TASK_DEFAULTS,
  TASK_TYPES,
  type TaskType,
  TIERS,
  type Tier,
} from "@/services/llm/tasks";
import type { AppSettings, TaskOverride } from "@/services/settings";

const NONE = "__none__";

const Row = z
  .object({ providerId: z.string(), model: z.string().trim() })
  .refine((r) => r.providerId === NONE || r.model.length > 0, {
    message: "Enter a model id",
    path: ["model"],
  });
const TiersForm = z.object({ fast: Row, standard: Row, strong: Row });
type TiersValues = z.infer<typeof TiersForm>;

const TIER_COPY: Record<Tier, string> = {
  fast: "Cheap and quick: segmentation, reranking, summaries.",
  standard: "The workhorse: classification, drafting, briefs, chat.",
  strong: "Rare, high-value calls and escalations.",
};

function toForm(s: AppSettings): TiersValues {
  const row = (t: Tier) => ({
    providerId: s.tiers[t]?.providerId ?? NONE,
    model: s.tiers[t]?.model ?? "",
  });
  return { fast: row("fast"), standard: row("standard"), strong: row("strong") };
}

function TiersCard({ settings }: { settings: AppSettings }) {
  const update = useUpdateSettings();
  const client = useQueryClient();
  const onError = useErrorToast();
  const form = useForm<TiersValues>({
    resolver: zodResolver(TiersForm),
    defaultValues: toForm(settings),
  });
  useEffect(() => form.reset(toForm(settings)), [settings, form]);
  const dirty = form.formState.isDirty;

  const test = useMutation({
    mutationFn: (tier: Tier) => run(Effect.flatMap(Llm, (llm) => llm.test({ tier }))),
    onSuccess: (r, tier) =>
      toast.success(`${tier} tier (${r.model}) answered in ${r.durationMs} ms`, {
        description: `"${r.text.trim().slice(0, 80)}"`,
      }),
    onError: (e) => onError(e),
    onSettled: () => {
      client.invalidateQueries({ queryKey: queryKeys.usage });
      client.invalidateQueries({ queryKey: queryKeys.recentCalls });
    },
  });

  const onSubmit = form.handleSubmit((v) =>
    update.mutate(
      (s) => {
        const bind = (t: Tier) =>
          v[t].providerId === NONE ? null : { providerId: v[t].providerId, model: v[t].model };
        return {
          ...s,
          tiers: { fast: bind("fast"), standard: bind("standard"), strong: bind("strong") },
        };
      },
      { onSuccess: () => toast.success("Tiers saved") },
    ),
  );

  return (
    <Card>
      <form onSubmit={onSubmit}>
        <CardHeader>
          <CardTitle>Model tiers</CardTitle>
          <CardDescription>
            An unconfigured tier falls back to the next stronger one (then weaker), so one model is
            enough to start.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {TIERS.map((tier) => {
            const providerId = form.watch(`${tier}.providerId`);
            const provider = settings.providers.find((p) => p.id === providerId);
            const error = form.formState.errors[tier]?.model;
            return (
              <div key={tier} className="grid grid-cols-[7rem_1fr_1fr_auto] items-start gap-3">
                <div>
                  <p className="text-sm font-medium capitalize">{tier}</p>
                  <p className="text-xs text-muted-foreground">{TIER_COPY[tier]}</p>
                </div>
                <Controller
                  control={form.control}
                  name={`${tier}.providerId`}
                  render={({ field }) => (
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger aria-label={`${tier} provider`} className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>Not configured</SelectItem>
                        {settings.providers.map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                <div>
                  <Input
                    aria-label={`${tier} model`}
                    placeholder={
                      provider?.kind === "anthropic"
                        ? ANTHROPIC_MODEL_SUGGESTIONS[tier]
                        : "model id"
                    }
                    list={provider?.kind === "anthropic" ? "anthropic-models" : undefined}
                    disabled={providerId === NONE}
                    className="font-mono text-xs"
                    {...form.register(`${tier}.model`)}
                  />
                  <FieldError errors={[error]} />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={dirty || !settings.tiers[tier] || test.isPending}
                  title={dirty ? "Save first" : undefined}
                  onClick={() => test.mutate(tier)}
                >
                  Test
                </Button>
              </div>
            );
          })}
          <datalist id="anthropic-models">
            {Object.values(ANTHROPIC_MODEL_SUGGESTIONS).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </CardContent>
        <CardFooter className="mt-4">
          <Button type="submit" disabled={!dirty || update.isPending}>
            Save tiers
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

function RoutingCard({ settings }: { settings: AppSettings }) {
  const update = useUpdateSettings();
  const setOverride = (task: TaskType, patch: TaskOverride) =>
    update.mutate((s) => {
      const next = { ...(s.taskOverrides[task] ?? {}), ...patch };
      if (next.tier === undefined) delete next.tier;
      if (next.escalate === undefined) delete next.escalate;
      const overrides = { ...s.taskOverrides };
      if (Object.keys(next).length === 0) delete overrides[task];
      else overrides[task] = next;
      return { ...s, taskOverrides: overrides };
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Task routing</CardTitle>
        <CardDescription>
          Each task names a tier, not a model. Escalation retries once on the next stronger tier
          when output fails validation or confidence is low.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Task</TableHead>
              <TableHead>Tier</TableHead>
              <TableHead>Escalate</TableHead>
              <TableHead>Resolves to</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {TASK_TYPES.map((task) => {
              const defaults = TASK_DEFAULTS[task];
              const override = settings.taskOverrides[task] ?? {};
              const route = resolveTask(settings, task);
              return (
                <TableRow key={task}>
                  <TableCell>
                    <p className="font-medium">{defaults.label}</p>
                    <p className="text-xs text-muted-foreground">{defaults.description}</p>
                  </TableCell>
                  <TableCell>
                    <Select
                      value={override.tier ?? "default"}
                      onValueChange={(v) =>
                        setOverride(task, { tier: v === "default" ? undefined : (v as Tier) })
                      }
                    >
                      <SelectTrigger
                        size="sm"
                        aria-label={`${defaults.label} tier`}
                        className="w-36"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">Default ({defaults.tier})</SelectItem>
                        {TIERS.map((t) => (
                          <SelectItem key={t} value={t}>
                            {t}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Switch
                      aria-label={`${defaults.label} escalation`}
                      checked={route.escalate}
                      onCheckedChange={(checked) =>
                        setOverride(task, {
                          escalate: checked === defaults.escalate ? undefined : checked,
                        })
                      }
                    />
                  </TableCell>
                  <TableCell>
                    {route.resolved ? (
                      <span className="flex items-center gap-2">
                        <Badge
                          variant={
                            route.resolved.tier === route.requestedTier ? "secondary" : "outline"
                          }
                        >
                          {route.resolved.tier}
                        </Badge>
                        <span className="font-mono text-xs">{route.resolved.binding.model}</span>
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">No tier configured</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function ModelsSection() {
  const { data: settings } = useSettings();
  if (!settings) return null;
  return (
    <div className="flex flex-col gap-4">
      <TiersCard settings={settings} />
      <RoutingCard settings={settings} />
    </div>
  );
}

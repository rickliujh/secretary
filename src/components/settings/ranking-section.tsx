import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { useSettings, useUpdateSettings } from "@/app/hooks";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  DEFAULT_WEIGHTS,
  type ScoringWeights,
  ScoringWeightsSchema,
} from "@/services/settings/schema";

const LABELS: Record<keyof ScoringWeights, [string, string]> = {
  priority: ["Jira priority", "Highest counts fully, Lowest barely."],
  due: ["Due date", "Full weight when due today or overdue, none two weeks out."],
  blocked: ["Blocked", "Blocked by an open issue, a blocked status or dependency."],
  blocking: ["Blocking others", "Full weight when it blocks three or more open issues."],
  stale: ["Staleness", "Rises after a week without updates, full at 30 days."],
  dependency: ["Overdue dependency", "Full weight at a week overdue."],
  pinned: ["Pinned", "Added to pinned tickets."],
};

/** A weight typed as text, checked against the limits the settings schema sets. */
const weight = (k: keyof ScoringWeights) => {
  const max = ScoringWeightsSchema.shape[k].unwrap().maxValue ?? Number.POSITIVE_INFINITY;
  return z.coerce
    .number<string>({ error: "Enter a number" })
    .min(0, "At least 0")
    .max(max, `At most ${max}`);
};

const Form = z.object({
  priority: weight("priority"),
  due: weight("due"),
  blocked: weight("blocked"),
  blocking: weight("blocking"),
  stale: weight("stale"),
  dependency: weight("dependency"),
  pinned: weight("pinned"),
});
type Values = z.input<typeof Form>;

const toValues = (w: ScoringWeights): Values =>
  Object.fromEntries(Object.entries(w).map(([k, v]) => [k, String(v)])) as Values;

/** Weights for Top focus (FR-5.2); scores update as soon as they are saved. */
export function RankingSection() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const form = useForm<Values, unknown, ScoringWeights>({
    resolver: zodResolver(Form),
    defaultValues: toValues(DEFAULT_WEIGHTS),
  });
  useEffect(() => {
    if (settings) form.reset(toValues(settings.scoring));
  }, [settings, form]);

  const save = (scoring: ScoringWeights) =>
    update.mutate((s) => ({ ...s, scoring }), {
      onSuccess: () => toast.success("Ranking updated"),
    });
  const errors = form.formState.errors;

  return (
    <Card>
      <form onSubmit={form.handleSubmit(save)}>
        <CardHeader>
          <CardTitle>Top focus ranking</CardTitle>
          <CardDescription>
            Each factor is scaled from 0 to 1 and multiplied by its weight. Your per-ticket
            adjustment is added on top. Set a weight to 0 to ignore a factor.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-4">
          {(Object.keys(LABELS) as (keyof ScoringWeights)[]).map((k) => (
            <Field key={k} data-invalid={!!errors[k]}>
              <FieldLabel htmlFor={`w-${k}`}>{LABELS[k][0]}</FieldLabel>
              <Input
                id={`w-${k}`}
                type="number"
                step="0.5"
                min={0}
                className="max-w-28"
                {...form.register(k)}
              />
              <FieldDescription>{LABELS[k][1]}</FieldDescription>
              <FieldError errors={[errors[k]]} />
            </Field>
          ))}
        </CardContent>
        <CardFooter className="mt-4 gap-2">
          <Button type="submit" disabled={!form.formState.isDirty || update.isPending}>
            Save
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => form.reset(toValues(DEFAULT_WEIGHTS), { keepDefaultValues: true })}
          >
            Restore defaults
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

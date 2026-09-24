import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
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

type Values = Record<keyof ScoringWeights, string>;
const toValues = (w: ScoringWeights): Values =>
  Object.fromEntries(Object.entries(w).map(([k, v]) => [k, String(v)])) as Values;

/** Weights for Top focus (FR-5.2); scores update as soon as they are saved. */
export function RankingSection() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const form = useForm<Values>({ defaultValues: toValues(DEFAULT_WEIGHTS) });
  useEffect(() => {
    if (settings) form.reset(toValues(settings.scoring));
  }, [settings, form]);

  const save = (values: Values) => {
    const parsed = ScoringWeightsSchema.safeParse(
      Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Number(v)])),
    );
    if (!parsed.success) {
      toast.error("Weights must be numbers between 0 and 20 (pinned up to 50).");
      return;
    }
    update.mutate((s) => ({ ...s, scoring: parsed.data }), {
      onSuccess: () => toast.success("Ranking updated"),
    });
  };

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
            <Field key={k}>
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

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  type AppSettings,
  RULE_NAMES,
  type RuleName,
  WorkSettingsSchema,
} from "@/services/settings/schema";
import { RULE_LABELS } from "@/services/work/rules";

const whole = (schema: z.ZodNumber, message: string) =>
  z
    .string()
    .trim()
    .refine((v) => /^\d+$/.test(v) && schema.safeParse(Number(v)).success, { message });

const shape = WorkSettingsSchema.shape;
const Form = z.object({
  enabled: z.boolean(),
  questionsPerDay: whole(shape.questionsPerDay.unwrap(), "A whole number from 0 to 50"),
  stateCallsPerDay: whole(shape.stateCallsPerDay.unwrap(), "A whole number from 0 to 1000"),
  groupSizeCap: whole(shape.groupSizeCap.unwrap(), "A whole number from 2 to 50"),
});
type Values = z.infer<typeof Form>;

const toValues = (s: AppSettings): Values => ({
  enabled: s.work.enabled,
  questionsPerDay: String(s.work.questionsPerDay),
  stateCallsPerDay: String(s.work.stateCallsPerDay),
  groupSizeCap: String(s.work.groupSizeCap),
});

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The consequence rules' switches (FR-19.6, Phase 25): each offers outcome
 * cards when its fact changes. A switch saves at once.
 */
function RuleSwitches() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const rules = settings?.secretary.rules;
  const set = (rule: RuleName, on: boolean) =>
    update.mutate((s) => ({
      ...s,
      secretary: { ...s.secretary, rules: { ...s.secretary.rules, [rule]: on } },
    }));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Follow-ups</CardTitle>
        <CardDescription>
          When a fact changes, the secretary works out what else is now out of date and offers the
          follow-ups as one card in the Inbox and on Today, each step one you can leave out, with
          one Approve. Nothing runs until you approve it. A kind you dismiss twice on the same work
          item goes quiet there; ask for it again from the item's Work tab.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup>
          {RULE_NAMES.map((rule) => (
            <Field key={rule} orientation="horizontal">
              <Switch
                id={`rule-${rule}`}
                checked={rules?.[rule] ?? true}
                disabled={!rules || update.isPending || settings?.work.enabled === false}
                onCheckedChange={(on) => set(rule, on)}
              />
              <div className="flex flex-col gap-0.5">
                <FieldLabel htmlFor={`rule-${rule}`}>{capital(RULE_LABELS[rule].name)}</FieldLabel>
                <FieldDescription>{RULE_LABELS[rule].offers}</FieldDescription>
              </div>
            </Field>
          ))}
        </FieldGroup>
      </CardContent>
    </Card>
  );
}

/** Settings > Secretary (D61): the work model's switch and budgets, and the follow-up rules. */
export function SecretarySection() {
  return (
    <div className="flex flex-col gap-6">
      <WorkCard />
      <RuleSwitches />
    </div>
  );
}

function WorkCard() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const form = useForm<Values>({
    resolver: zodResolver(Form),
    defaultValues: {
      enabled: true,
      questionsPerDay: "3",
      stateCallsPerDay: "60",
      groupSizeCap: "8",
    },
  });
  useEffect(() => {
    if (settings) form.reset(toValues(settings));
  }, [settings, form]);
  const errors = form.formState.errors;
  const save = form.handleSubmit((v) =>
    update.mutate(
      (s) => ({
        ...s,
        work: {
          enabled: v.enabled,
          questionsPerDay: Number(v.questionsPerDay),
          stateCallsPerDay: Number(v.stateCallsPerDay),
          groupSizeCap: Number(v.groupSizeCap),
        },
      }),
      { onSuccess: () => toast.success("Secretary settings saved") },
    ),
  );
  const number = (
    name: "questionsPerDay" | "stateCallsPerDay" | "groupSizeCap",
    label: string,
    description: string,
  ) => (
    <Field data-invalid={!!errors[name]}>
      <FieldLabel htmlFor={`work-${name}`}>{label}</FieldLabel>
      <Input id={`work-${name}`} inputMode="numeric" className="w-32" {...form.register(name)} />
      <FieldDescription>{description}</FieldDescription>
      <FieldError errors={[errors[name]]} />
    </Field>
  );
  return (
    <Card>
      <form onSubmit={save}>
        <CardHeader>
          <CardTitle>Your work</CardTitle>
          <CardDescription>
            The secretary groups your active tickets into work items, records what happens to each,
            keeps a short status note, and asks when it is not sure. It all stays on this computer;
            nothing here writes to Jira.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Controller
              control={form.control}
              name="enabled"
              render={({ field }) => (
                <Field orientation="horizontal">
                  <Switch
                    id="work-enabled"
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                  <FieldLabel htmlFor="work-enabled">Keep track of my work items</FieldLabel>
                </Field>
              )}
            />
            {number(
              "questionsPerDay",
              "Questions a day",
              "Questions about your work items, beyond those in the Inbox thread you are in. The most important come first; the rest wait for the next day.",
            )}
            {number(
              "stateCallsPerDay",
              "Status updates a day",
              "Model calls that bring work items up to date. When they run out, items catch up the next day.",
            )}
            {number(
              "groupSizeCap",
              "Most tickets in one item",
              "A group would be larger: the secretary keeps it apart and asks you instead.",
            )}
          </FieldGroup>
        </CardContent>
        <CardFooter className="mt-4">
          <Button type="submit" disabled={update.isPending}>
            Save
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { useSettings, useUpdateSettings } from "@/app/hooks";
import { useUserSprintLoad } from "@/components/inbox/use-sprint-fit";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { DaysPerPoint, decimal } from "./days-per-point";

const Form = z.object({
  outputLanguage: z.string().trim().min(1, "Enter a language"),
  daysPerPoint: DaysPerPoint,
  followupDays: z.coerce.number<string>().int().min(1, "At least 1").max(30, "At most 30"),
  reminders: z.boolean(),
  fiscalYearStartMonth: z.string(),
});

const roundRate = (n: number) => String(Math.round(n * 100) / 100);

const MONTHS = Array.from({ length: 12 }, (_, i) =>
  new Date(2026, i, 1).toLocaleString("en", { month: "long" }),
);
type FormInput = z.input<typeof Form>;

export function GeneralSection() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const form = useForm<FormInput, unknown, z.output<typeof Form>>({
    resolver: zodResolver(Form),
    defaultValues: {
      outputLanguage: "English",
      followupDays: "3",
      reminders: true,
      fiscalYearStartMonth: "1",
      daysPerPoint: "",
    },
  });
  const load = useUserSprintLoad();
  const derived = load.data?.derived ?? null;

  useEffect(() => {
    if (settings)
      form.reset({
        outputLanguage: settings.general.outputLanguage,
        followupDays: String(settings.dependencies.followupDays),
        reminders: settings.dependencies.reminders,
        fiscalYearStartMonth: String(settings.general.fiscalYearStartMonth),
        daysPerPoint:
          settings.sprint.daysPerPoint === null ? "" : String(settings.sprint.daysPerPoint),
      });
  }, [settings, form]);

  const onSubmit = form.handleSubmit((values) =>
    update.mutate(
      (s) => ({
        ...s,
        general: {
          ...s.general,
          outputLanguage: values.outputLanguage,
          fiscalYearStartMonth: Number(values.fiscalYearStartMonth),
        },
        dependencies: { followupDays: values.followupDays, reminders: values.reminders },
        sprint: {
          ...s.sprint,
          daysPerPoint: values.daysPerPoint === "" ? null : decimal(values.daysPerPoint),
        },
      }),
      { onSuccess: () => toast.success("Saved") },
    ),
  );

  return (
    <Card>
      <form onSubmit={onSubmit}>
        <CardHeader>
          <CardTitle>General</CardTitle>
          <CardDescription>Defaults for drafting, briefs and follow-ups.</CardDescription>
        </CardHeader>
        <CardContent>
          <Field data-invalid={!!form.formState.errors.outputLanguage}>
            <FieldLabel htmlFor="outputLanguage">Output language</FieldLabel>
            <Input id="outputLanguage" className="max-w-xs" {...form.register("outputLanguage")} />
            <FieldDescription>
              Language for drafts and briefs. Contacts can override it later.
            </FieldDescription>
            <FieldError errors={[form.formState.errors.outputLanguage]} />
          </Field>
          <Controller
            control={form.control}
            name="fiscalYearStartMonth"
            render={({ field }) => (
              <Field className="mt-4">
                <FieldLabel htmlFor="fiscalYearStartMonth">Fiscal year starts in</FieldLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="fiscalYearStartMonth" className="w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MONTHS.map((m, i) => (
                      <SelectItem key={m} value={String(i + 1)}>
                        {m}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>
                  Sets what Q1 to Q4 mean when a message says something like "the second sprint of
                  Q3". January means calendar quarters.
                </FieldDescription>
              </Field>
            )}
          />
          <Field data-invalid={!!form.formState.errors.daysPerPoint} className="mt-4">
            <FieldLabel htmlFor="daysPerPoint">Sprint: one story point is about</FieldLabel>
            <div className="flex items-center gap-2">
              <Input
                id="daysPerPoint"
                inputMode="decimal"
                className="max-w-24"
                placeholder={derived ? roundRate(derived.daysPerPoint) : ""}
                {...form.register("daysPerPoint")}
              />
              <span className="text-sm text-muted-foreground">working days</span>
            </div>
            <FieldDescription>
              Says whether a new ticket fits your sprint.{" "}
              {derived
                ? `Left empty, your last ${derived.sprints === 1 ? "sprint gives" : `${derived.sprints} sprints give`} about ${roundRate(derived.daysPerPoint)} days a point.`
                : "Left empty, the rate comes from your last three closed sprints; there are none with finished points yet."}
            </FieldDescription>
            <FieldError errors={[form.formState.errors.daysPerPoint]} />
          </Field>
          <Field data-invalid={!!form.formState.errors.followupDays} className="mt-4">
            <FieldLabel htmlFor="followupDays">Follow up after (working days)</FieldLabel>
            <Input
              id="followupDays"
              inputMode="numeric"
              className="max-w-24"
              {...form.register("followupDays")}
            />
            <FieldDescription>
              Default gap before the next chase when you log a follow-up.
            </FieldDescription>
            <FieldError errors={[form.formState.errors.followupDays]} />
          </Field>
          <Controller
            control={form.control}
            name="reminders"
            render={({ field }) => (
              <Field orientation="horizontal" className="mt-4">
                <Switch id="reminders" checked={field.value} onCheckedChange={field.onChange} />
                <FieldLabel htmlFor="reminders">Notify me when a follow-up is due</FieldLabel>
              </Field>
            )}
          />
        </CardContent>
        <CardFooter className="mt-4">
          <Button type="submit" disabled={!form.formState.isDirty || update.isPending}>
            Save
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

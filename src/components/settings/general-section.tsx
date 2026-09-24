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
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

const Form = z.object({
  outputLanguage: z.string().trim().min(1, "Enter a language"),
  followupDays: z.coerce.number<string>().int().min(1, "At least 1").max(30, "At most 30"),
  reminders: z.boolean(),
});
type FormInput = z.input<typeof Form>;

export function GeneralSection() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const form = useForm<FormInput, unknown, z.output<typeof Form>>({
    resolver: zodResolver(Form),
    defaultValues: { outputLanguage: "English", followupDays: "3", reminders: true },
  });

  useEffect(() => {
    if (settings)
      form.reset({
        outputLanguage: settings.general.outputLanguage,
        followupDays: String(settings.dependencies.followupDays),
        reminders: settings.dependencies.reminders,
      });
  }, [settings, form]);

  const onSubmit = form.handleSubmit((values) =>
    update.mutate(
      (s) => ({
        ...s,
        general: { ...s.general, outputLanguage: values.outputLanguage },
        dependencies: { followupDays: values.followupDays, reminders: values.reminders },
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

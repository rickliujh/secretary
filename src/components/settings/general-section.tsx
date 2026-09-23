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

const Form = z.object({ outputLanguage: z.string().trim().min(1, "Enter a language") });

export function GeneralSection() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const form = useForm({
    resolver: zodResolver(Form),
    defaultValues: { outputLanguage: "English" },
  });

  useEffect(() => {
    if (settings) form.reset({ outputLanguage: settings.general.outputLanguage });
  }, [settings, form]);

  const onSubmit = form.handleSubmit((values) =>
    update.mutate(
      (s) => ({ ...s, general: { ...s.general, outputLanguage: values.outputLanguage } }),
      {
        onSuccess: () => toast.success("Saved"),
      },
    ),
  );

  return (
    <Card>
      <form onSubmit={onSubmit}>
        <CardHeader>
          <CardTitle>General</CardTitle>
          <CardDescription>Defaults used across drafting and briefs.</CardDescription>
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

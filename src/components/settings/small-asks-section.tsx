import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { useErrorToast, useSettings, useUpdateSettings } from "@/app/hooks";
import { run } from "@/app/runtime";
import { SMALL_ASK_KEYS } from "@/components/inbox/small-ask-keys";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { type AppSettings, JiraLabel } from "@/services/settings/schema";
import { checkHome, type HomeCheck, syncedProjectKeys } from "@/services/small-asks/queries";

const NONE = "__none__";

const Form = z.object({
  projectKey: z.string(),
  label: JiraLabel,
  joinActiveSprint: z.boolean(),
});
type Values = z.infer<typeof Form>;

const toValues = (s: AppSettings): Values => ({
  projectKey: s.smallAsks.projectKey,
  label: s.smallAsks.label,
  joinActiveSprint: s.smallAsks.joinActiveSprint,
});

function CheckResult({ check }: { check: HomeCheck }) {
  const problems = check.blocked.length > 0 || check.noLabels.length > 0;
  if (check.issueTypes.length === 0)
    return (
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>{check.projectKey} offers no issue type for a small ask</AlertTitle>
        <AlertDescription>
          Jira lists only epics or sub-tasks you can create there. Pick another project.
        </AlertDescription>
      </Alert>
    );
  return (
    <Alert>
      {problems ? <AlertTriangle /> : <CheckCircle2 />}
      <AlertTitle>
        Small asks in {check.projectKey} can be {check.issueTypes.join(", ")}
        {check.defaultType ? ` (${check.defaultType} unless the secretary picks another)` : ""}.
      </AlertTitle>
      {problems && (
        <AlertDescription>
          <ul className="list-disc pl-4">
            {check.blocked.map((b) => (
              <li key={b.issueType}>
                {b.issueType}: Jira requires {b.fields.join(", ")}, which the app cannot fill, so
                creating one will fail.
              </li>
            ))}
            {check.noLabels.length > 0 && (
              <li>
                {check.noLabels.join(", ")}: no Labels field on the create screen, so the label is
                not set.
              </li>
            )}
          </ul>
        </AlertDescription>
      )}
    </Alert>
  );
}

/** The small-asks home (FR-10.1, D44): where small asks become tickets. */
export function SmallAsksSection() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const client = useQueryClient();
  const onError = useErrorToast();
  const projects = useQuery({
    queryKey: SMALL_ASK_KEYS.projects,
    queryFn: ({ signal }) => run(syncedProjectKeys, signal),
  });
  const check = useMutation({
    mutationFn: (projectKey: string) => run(checkHome(projectKey)),
    onError: (e) => onError(e),
  });
  const form = useForm<Values>({
    resolver: zodResolver(Form),
    defaultValues: { projectKey: "", label: "small-ask", joinActiveSprint: true },
  });
  useEffect(() => {
    if (settings) form.reset(toValues(settings));
  }, [settings, form]);
  const errors = form.formState.errors;

  const save = form.handleSubmit((v) =>
    update.mutate(
      (s) => ({
        ...s,
        smallAsks: {
          ...s.smallAsks,
          projectKey: v.projectKey,
          label: v.label,
          joinActiveSprint: v.joinActiveSprint,
        },
      }),
      {
        onSuccess: () => {
          void client.invalidateQueries({ queryKey: SMALL_ASK_KEYS.home });
          toast.success(v.projectKey ? "Small-asks home saved" : "Small asks turned off");
          check.reset();
          if (v.projectKey) check.mutate(v.projectKey);
        },
      },
    ),
  );

  const options = [
    ...new Set([
      ...(projects.data ?? []),
      ...(settings?.smallAsks.projectKey ? [settings.smallAsks.projectKey] : []),
    ]),
  ].sort();

  return (
    <Card>
      <form onSubmit={save}>
        <CardHeader>
          <CardTitle>Small asks</CardTitle>
          <CardDescription>
            Small tasks that come up beside planned work (a reply you owe, something to send or
            check) become tickets here, assigned to you, with one click in the Inbox. The secretary
            picks the type and epic; you can change both before you track it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Controller
              control={form.control}
              name="projectKey"
              render={({ field }) => (
                <Field>
                  <FieldLabel htmlFor="small-asks-project">Project</FieldLabel>
                  <Select
                    value={field.value || NONE}
                    onValueChange={(v) => field.onChange(v === NONE ? "" : v)}
                  >
                    <SelectTrigger id="small-asks-project" className="w-56">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>None (off)</SelectItem>
                      {options.map((k) => (
                        <SelectItem key={k} value={k}>
                          {k}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldDescription>
                    Projects from your synced tickets. With none, the Inbox works as before.
                  </FieldDescription>
                </Field>
              )}
            />
            <Field data-invalid={!!errors.label}>
              <FieldLabel htmlFor="small-asks-label">Label</FieldLabel>
              <Input
                id="small-asks-label"
                className="max-w-xs font-mono"
                {...form.register("label")}
              />
              <FieldDescription>
                Every small ask gets this label, so you can find them.
              </FieldDescription>
              <FieldError errors={[errors.label]} />
            </Field>
            <Controller
              control={form.control}
              name="joinActiveSprint"
              render={({ field }) => (
                <Field orientation="horizontal">
                  <Switch
                    id="small-asks-sprint"
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                  <FieldLabel htmlFor="small-asks-sprint">
                    Add new small asks to the active sprint that holds your work
                  </FieldLabel>
                </Field>
              )}
            />
          </FieldGroup>
          {check.isPending && (
            <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Reading what Jira needs to create issues
              there
            </p>
          )}
          {check.data && (
            <div className="mt-4">
              <CheckResult check={check.data} />
            </div>
          )}
        </CardContent>
        <CardFooter className="mt-4 gap-2">
          <Button type="submit" disabled={!form.formState.isDirty || update.isPending}>
            Save
          </Button>
          {settings?.smallAsks.projectKey && (
            <Button
              type="button"
              variant="outline"
              disabled={check.isPending}
              onClick={() => check.mutate(settings.smallAsks.projectKey)}
            >
              Check project
            </Button>
          )}
        </CardFooter>
      </form>
    </Card>
  );
}

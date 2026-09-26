import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { useErrorToast, useSettings, useUpdateSettings } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { runSync, useSyncStatus } from "@/app/sync";
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
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { dateTime } from "@/lib/time";
import { storyPointFields } from "@/services/jira/fields";
import { ISSUE_KEY_RE } from "@/services/proposals/schema";
import type { AppSettings } from "@/services/settings";
import { Sync } from "@/services/sync";

const splitKeys = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((k) => k.trim().toUpperCase())
    .filter(Boolean);

const ScopeForm = z
  .object({
    jql: z.string(),
    trackedEpics: z.string(),
    syncIntervalMinutes: z.coerce
      .number<string>()
      .int()
      .min(1, "At least 1")
      .max(1440, "At most 1440"),
  })
  .superRefine((v, ctx) => {
    const bad = splitKeys(v.trackedEpics).filter((k) => !ISSUE_KEY_RE.test(k));
    if (bad.length)
      ctx.addIssue({
        code: "custom",
        path: ["trackedEpics"],
        message: `Not issue keys: ${bad.join(", ")}`,
      });
    if (!v.jql.trim() && splitKeys(v.trackedEpics).length === 0)
      ctx.addIssue({
        code: "custom",
        path: ["jql"],
        message: "Set a JQL query or at least one tracked epic",
      });
  });
type ScopeInput = z.input<typeof ScopeForm>;

const scopeDefaults = (s: AppSettings): ScopeInput => ({
  jql: s.jira.jql,
  trackedEpics: s.jira.trackedEpics.join(", "),
  syncIntervalMinutes: String(s.jira.syncIntervalMinutes),
});

function ScopeCard({ settings }: { settings: AppSettings }) {
  const update = useUpdateSettings();
  const form = useForm<ScopeInput, unknown, z.output<typeof ScopeForm>>({
    resolver: zodResolver(ScopeForm),
    defaultValues: scopeDefaults(settings),
  });
  useEffect(() => form.reset(scopeDefaults(settings)), [settings, form]);
  const errors = form.formState.errors;

  const onSubmit = form.handleSubmit((v) =>
    update.mutate(
      (s) => ({
        ...s,
        jira: {
          ...s.jira,
          jql: v.jql.trim(),
          trackedEpics: [...new Set(splitKeys(v.trackedEpics))],
          syncIntervalMinutes: v.syncIntervalMinutes,
        },
      }),
      { onSuccess: () => toast.success("Sync scope saved. It applies from the next sync.") },
    ),
  );

  return (
    <Card>
      <form onSubmit={onSubmit}>
        <CardHeader>
          <CardTitle>Sync scope</CardTitle>
          <CardDescription>
            Issues matching the JQL, plus tracked epics with their stories and sub-tasks, are cached
            locally.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field data-invalid={!!errors.jql}>
              <FieldLabel htmlFor="jira-jql">JQL</FieldLabel>
              <Textarea
                id="jira-jql"
                rows={3}
                className="font-mono text-xs"
                {...form.register("jql")}
              />
              <FieldDescription>
                Any ORDER BY clause is ignored; sync orders by last update.
              </FieldDescription>
              <FieldError errors={[errors.jql]} />
            </Field>
            <Field data-invalid={!!errors.trackedEpics}>
              <FieldLabel htmlFor="jira-epics">Tracked epics</FieldLabel>
              <Input
                id="jira-epics"
                placeholder="PAY-1, OPS-12"
                className="font-mono"
                {...form.register("trackedEpics")}
              />
              <FieldDescription>
                Children of these epics are always synced and they get a health rollup later.
              </FieldDescription>
              <FieldError errors={[errors.trackedEpics]} />
            </Field>
            <Field data-invalid={!!errors.syncIntervalMinutes}>
              <FieldLabel htmlFor="jira-interval">Sync every (minutes)</FieldLabel>
              <Input
                id="jira-interval"
                inputMode="numeric"
                className="max-w-24"
                {...form.register("syncIntervalMinutes")}
              />
              <FieldError errors={[errors.syncIntervalMinutes]} />
            </Field>
          </FieldGroup>
        </CardContent>
        <CardFooter className="mt-4">
          <Button type="submit" disabled={!form.formState.isDirty || update.isPending}>
            Save scope
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

const FIELD_LABELS = {
  epicLink: "Epic Link",
  epicName: "Epic Name",
  sprint: "Sprint",
  storyPoints: "Story Points",
} as const;
type FieldKey = keyof typeof FIELD_LABELS;

function FieldsCard({ settings }: { settings: AppSettings }) {
  const update = useUpdateSettings();
  const client = useQueryClient();
  const onError = useErrorToast();
  const info = useQuery({
    queryKey: queryKeys.fieldInfo,
    queryFn: ({ signal }) =>
      run(
        Effect.flatMap(Sync, (s) => s.fieldInfo),
        signal,
      ),
  });
  const discover = useMutation({
    mutationFn: () => run(Effect.flatMap(Sync, (s) => s.discoverFields)),
    onSuccess: (r) => {
      client.setQueryData(queryKeys.fieldInfo, r);
      toast.success("Custom fields discovered");
    },
    onError: (e) => onError(e),
  });
  const form = useForm<Record<FieldKey, string>>({
    defaultValues: {
      epicLink: settings.jira.fields.epicLink ?? "",
      epicName: settings.jira.fields.epicName ?? "",
      sprint: settings.jira.fields.sprint ?? "",
      storyPoints: settings.jira.fields.storyPoints ?? "",
    },
  });
  const onSubmit = form.handleSubmit((v) =>
    update.mutate(
      (s) => ({
        ...s,
        jira: {
          ...s.jira,
          fields: {
            epicLink: v.epicLink.trim() || undefined,
            epicName: v.epicName.trim() || undefined,
            sprint: v.sprint.trim() || undefined,
            storyPoints: v.storyPoints.trim() || undefined,
          },
        },
      }),
      {
        onSuccess: () => {
          client.invalidateQueries({ queryKey: queryKeys.fieldInfo });
          toast.success("Field overrides saved");
        },
      },
    ),
  );

  return (
    <Card>
      <form onSubmit={onSubmit}>
        <CardHeader>
          <CardTitle>Custom fields</CardTitle>
          <CardDescription>
            Discovered from /rest/api/2/field on every sync. Override only if your instance uses
            different fields.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {(Object.keys(FIELD_LABELS) as FieldKey[]).map((k) => (
            <div key={k} className="grid grid-cols-[8rem_10rem_1fr] items-center gap-3">
              <span className="text-sm font-medium">{FIELD_LABELS[k]}</span>
              {info.data?.discovered[k] ? (
                <div className="flex flex-wrap gap-1">
                  {/* Story points may come from two fields on Cloud (D35). */}
                  {(k === "storyPoints"
                    ? storyPointFields(info.data.discovered)
                    : [info.data.discovered[k]]
                  ).map((id) => (
                    <Badge key={id} variant="secondary" className="font-mono">
                      {id}
                    </Badge>
                  ))}
                </div>
              ) : (
                <span className="text-xs text-muted-foreground">Not discovered</span>
              )}
              <Input
                aria-label={`${FIELD_LABELS[k]} override`}
                placeholder="customfield_10100"
                className="font-mono text-xs"
                {...form.register(k)}
              />
            </div>
          ))}
        </CardContent>
        <CardFooter className="mt-4 gap-2">
          <Button type="submit" disabled={!form.formState.isDirty || update.isPending}>
            Save overrides
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={discover.isPending}
            onClick={() => discover.mutate()}
          >
            Discover now
          </Button>
        </CardFooter>
      </form>
    </Card>
  );
}

function SyncCard() {
  const status = useSyncStatus();
  const onError = useErrorToast();
  const start = (full: boolean) =>
    runSync(full)
      .then((r) =>
        toast.success(
          `Synced ${r.fetched} issues${r.staleMarked ? `, ${r.staleMarked} marked stale` : ""}`,
        ),
      )
      .catch((e) => onError(e));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sync</CardTitle>
        <CardDescription>
          Incremental sync runs on the timer. A full resync runs weekly and marks issues that left
          the scope as stale.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-2 text-sm">
        <span className="text-muted-foreground">Last sync</span>
        <span>{status?.lastSyncAt ? dateTime(status.lastSyncAt) : "Never"}</span>
        <span className="text-muted-foreground">Last full resync</span>
        <span>{status?.lastFullSyncAt ? dateTime(status.lastFullSyncAt) : "Never"}</span>
        {status?.lastError && (
          <>
            <span className="text-muted-foreground">Last error</span>
            <span className="text-destructive">{status.lastError}</span>
          </>
        )}
      </CardContent>
      <CardFooter className="mt-4 gap-2">
        <Button disabled={status?.running} onClick={() => start(false)}>
          {status?.running ? (status.phase ?? "Syncing...") : "Sync now"}
        </Button>
        <Button variant="outline" disabled={status?.running} onClick={() => start(true)}>
          Full resync
        </Button>
      </CardFooter>
    </Card>
  );
}

export function JiraSyncSection() {
  const { data: settings } = useSettings();
  if (!settings) return null;
  if (!settings.jira.baseUrl) {
    return (
      <p className="text-sm text-muted-foreground">
        Save a Jira base URL and token to configure sync.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <ScopeCard settings={settings} />
      <FieldsCard settings={settings} />
      <SyncCard />
    </div>
  );
}

import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Effect } from "effect";
import { Sparkles } from "lucide-react";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { useErrorToast, useSettings, useUpdateSettings } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { runCleanup } from "@/app/storage";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { relativeTime } from "@/lib/time";
import { cn } from "@/lib/utils";
import {
  type CleanupResult,
  databaseSize,
  lastCleanup,
  RETENTION,
  storageLevel,
} from "@/services/data/retention";

const Form = z.object({
  limitMb: z.coerce
    .number<string>()
    .int()
    .min(100, "At least 100 MB")
    .max(100_000, "At most 100,000 MB"),
});
type FormInput = z.input<typeof Form>;

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function cleanupSummary(r: CleanupResult & { backups?: number }) {
  const parts = [
    r.llmCalls && `${r.llmCalls} old usage records`,
    r.staleIssues && `${r.staleIssues} tickets no longer synced`,
    r.snapshots && `${r.snapshots} old inbox snapshots`,
    r.backups && `${r.backups} old import backups`,
  ].filter(Boolean);
  return parts.length ? `Removed ${parts.join(", ")}.` : "Nothing needed removing.";
}

/** Database size against the user's limit, and the cleanup they run by hand (D34). */
export function StorageCard() {
  const onError = useErrorToast();
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const storage = useQuery({
    queryKey: queryKeys.storage,
    queryFn: () => run(Effect.all({ size: databaseSize, last: lastCleanup })),
  });
  const clean = useMutation({
    mutationFn: runCleanup,
    onSuccess: (r) => toast.success(cleanupSummary(r)),
    onError: (e) => onError(e),
  });
  const form = useForm<FormInput, unknown, z.output<typeof Form>>({
    resolver: zodResolver(Form),
    defaultValues: { limitMb: "1024" },
  });
  useEffect(() => {
    if (settings) form.reset({ limitMb: String(settings.storage.limitMb) });
  }, [settings, form]);
  const onSubmit = form.handleSubmit((v) =>
    update.mutate((s) => ({ ...s, storage: { ...s.storage, limitMb: v.limitMb } }), {
      onSuccess: () => toast.success("Saved"),
    }),
  );

  const limitMb = settings?.storage.limitMb ?? 1024;
  const bytes = storage.data?.size.bytes ?? 0;
  const level = storageLevel(bytes, limitMb);
  const last = storage.data?.last;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Storage</CardTitle>
        <CardDescription>
          The app warns when the database gets near your limit. Nothing is removed until you click
          Clean up.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span>
              Database <span className="font-medium">{storage.data ? mb(bytes) : "..."}</span>
              <span className="text-muted-foreground"> of {limitMb} MB</span>
            </span>
            {level !== "ok" && (
              <span className={cn(level === "over" ? "text-destructive" : "text-amber-600")}>
                {level === "over" ? "Over the limit" : "Almost full"}
              </span>
            )}
          </div>
          <Progress
            value={Math.min(100, (bytes / (limitMb * 1024 * 1024)) * 100)}
            className={cn(
              level === "over" && "[&_[data-slot=progress-indicator]]:bg-destructive",
              level === "near" && "[&_[data-slot=progress-indicator]]:bg-amber-500",
            )}
          />
        </div>

        <form onSubmit={onSubmit} className="flex items-end gap-2">
          <Field data-invalid={!!form.formState.errors.limitMb}>
            <FieldLabel htmlFor="limitMb">Limit (MB)</FieldLabel>
            <Input
              id="limitMb"
              inputMode="numeric"
              className="max-w-32"
              {...form.register("limitMb")}
            />
            <FieldError errors={[form.formState.errors.limitMb]} />
          </Field>
          <Button type="submit" variant="outline" disabled={update.isPending}>
            Save
          </Button>
        </form>

        <div className="flex flex-wrap items-start justify-between gap-3 border-t pt-4">
          <div className="min-w-0 flex-1 text-sm">
            <FieldDescription>
              Clean up removes model usage records older than {RETENTION.llmCallsDays} days, tickets
              that left your sync scope more than {RETENTION.staleIssueDays} days ago, the ticket
              context saved with inbox items older than {RETENTION.snapshotDays} days, and all but
              the newest three import backups, then compacts the database. Your threads, notes,
              memories, chats and drafts are never removed.
            </FieldDescription>
            <p className="mt-2 text-muted-foreground">
              {last
                ? `Last cleanup ${relativeTime(last.at)}. ${cleanupSummary(last)}`
                : "Not cleaned up yet."}
            </p>
          </div>
          <Button variant="outline" disabled={clean.isPending} onClick={() => clean.mutate()}>
            <Sparkles /> {clean.isPending ? "Cleaning up..." : "Clean up"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

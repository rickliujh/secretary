import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, NotebookPen } from "lucide-react";
import { Controller, useForm, useWatch } from "react-hook-form";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ReportRequest } from "@/services/report";
import { PERIODS, type PeriodChoice, ReportForm, type ReportFormInput } from "./format";

/** The period, the scope and the "Write report" button. */
export function ReportControls({
  pending,
  onWrite,
}: {
  pending: boolean;
  onWrite: (req: ReportRequest) => void;
}) {
  const form = useForm<ReportFormInput, unknown, z.output<typeof ReportForm>>({
    resolver: zodResolver(ReportForm),
    defaultValues: { period: "workday", days: "5", tracked: false },
  });
  const period = useWatch({ control: form.control, name: "period" });
  const submit = form.handleSubmit(onWrite);

  return (
    <Card size="sm">
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Controller
            control={form.control}
            name="period"
            render={({ field }) => (
              <Field>
                <FieldLabel>Period</FieldLabel>
                <ToggleGroup
                  type="single"
                  variant="outline"
                  size="sm"
                  value={field.value}
                  onValueChange={(v) => v && field.onChange(v as PeriodChoice)}
                  className="flex-wrap"
                  aria-label="Period"
                >
                  {PERIODS.map((p) => (
                    <ToggleGroupItem key={p.value} value={p.value}>
                      {p.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Field>
            )}
          />
          {period === "custom" && (
            <Field data-invalid={!!form.formState.errors.days}>
              <div className="flex items-center gap-2 text-sm">
                <FieldLabel htmlFor="report-days" className="w-auto">
                  Last
                </FieldLabel>
                <Input
                  id="report-days"
                  type="number"
                  min={1}
                  max={30}
                  step={1}
                  inputMode="numeric"
                  className="h-8 w-20"
                  aria-invalid={!!form.formState.errors.days}
                  {...form.register("days")}
                />
                <span>days</span>
              </div>
              <FieldError errors={[form.formState.errors.days]} />
            </Field>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Controller
              control={form.control}
              name="tracked"
              render={({ field }) => (
                <Field orientation="horizontal" className="w-auto">
                  <Switch
                    id="report-tracked"
                    checked={field.value}
                    onCheckedChange={field.onChange}
                  />
                  <FieldLabel htmlFor="report-tracked">Include tracked epics</FieldLabel>
                </Field>
              )}
            />
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="animate-spin" /> : <NotebookPen />}
              {pending ? "Writing..." : "Write report"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

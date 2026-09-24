import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { useSettings } from "@/app/hooks";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { addBusinessDays } from "@/services/dependencies/logic";
import { logFollowup } from "@/services/dependencies/queries";
import { FOLLOWUP_CHANNELS } from "@/services/dependencies/schema";
import { localDate } from "@/services/intake";
import { useDependencyMutation } from "./use-dependencies";

type Values = {
  channel: (typeof FOLLOWUP_CHANNELS)[number];
  summary: string;
  nextFollowupAt: string;
};

/** Records that you chased (FR-3.1 timeline) and when to chase next. */
export function FollowupDialog({
  dependencyId,
  open,
  onOpenChange,
}: {
  dependencyId: string;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { data: settings } = useSettings();
  const days = settings?.dependencies.followupDays ?? 3;
  const form = useForm<Values>({
    defaultValues: {
      channel: "teams",
      summary: "",
      nextFollowupAt: addBusinessDays(localDate(), days),
    },
  });
  useEffect(() => {
    if (open)
      form.reset({
        channel: "teams",
        summary: "",
        nextFollowupAt: addBusinessDays(localDate(), days),
      });
  }, [open, days, form]);
  const save = useDependencyMutation(
    (v: Values) =>
      logFollowup(dependencyId, {
        channel: v.channel,
        summary: v.summary.trim() || null,
        nextFollowupAt: v.nextFollowupAt || null,
      }),
    "Follow-up logged",
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={form.handleSubmit((v) =>
            save.mutate(v, { onSuccess: () => onOpenChange(false) }),
          )}
        >
          <DialogHeader className="mb-4">
            <DialogTitle>Log a follow-up</DialogTitle>
            <DialogDescription>Record that you chased, and when to chase next.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Controller
              control={form.control}
              name="channel"
              render={({ field }) => (
                <Field>
                  <FieldLabel htmlFor="fu-channel">How</FieldLabel>
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="fu-channel" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {FOLLOWUP_CHANNELS.map((c) => (
                        <SelectItem key={c} value={c}>
                          {c}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
            />
            <Field>
              <FieldLabel htmlFor="fu-summary">What happened</FieldLabel>
              <Textarea
                id="fu-summary"
                rows={3}
                placeholder="Asked Ana for an ETA; she will check with Platform."
                {...form.register("summary")}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="fu-next">Next follow-up</FieldLabel>
              <Input id="fu-next" type="date" {...form.register("nextFollowupAt")} />
              <FieldDescription>
                Defaults to {days} working days from today. Clear it for no reminder.
              </FieldDescription>
            </Field>
          </FieldGroup>
          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              Log follow-up
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

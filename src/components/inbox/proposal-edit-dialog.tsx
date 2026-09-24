import { useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  PROPOSAL_LABELS,
  type ProposalPayload,
  ProposalPayloadSchema,
} from "@/services/proposals/schema";
import { FIELD_SPECS, fieldName, fromFormValues, toFormValues } from "./proposal-fields";
import type { Lookups } from "./use-inbox";

const UNSET = "__unset__";

export function ProposalEditDialog({
  payload,
  lookups,
  open,
  onOpenChange,
  onApprove,
}: {
  payload: ProposalPayload;
  lookups: Lookups;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Approves with the edited payload. */
  onApprove: (edited: ProposalPayload) => void;
}) {
  const form = useForm<Record<string, string>>({ defaultValues: toFormValues(payload) });
  const [errors, setErrors] = useState<string[]>([]);
  useEffect(() => {
    if (open) {
      form.reset(toFormValues(payload));
      setErrors([]);
    }
  }, [open, payload, form]);
  if (payload.kind === "needs_clarification") return null;
  const specs = FIELD_SPECS[payload.kind];

  const submit = form.handleSubmit((values) => {
    const parsed = ProposalPayloadSchema.safeParse(fromFormValues(payload, values));
    if (!parsed.success) {
      setErrors(parsed.error.issues.map((i) => `${i.path.join(".") || "proposal"}: ${i.message}`));
      return;
    }
    onApprove(parsed.data);
    onOpenChange(false);
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={submit}>
          <DialogHeader className="mb-4">
            <DialogTitle>Edit: {PROPOSAL_LABELS[payload.kind]}</DialogTitle>
            <DialogDescription>
              Your changes are saved as a correction so similar input goes better next time.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            {specs.map((spec) => {
              const name = fieldName(spec.path);
              const id = `edit-${name}`;
              return (
                <Field key={spec.path}>
                  <FieldLabel htmlFor={id}>{spec.label}</FieldLabel>
                  {spec.type === "textarea" ? (
                    <Textarea id={id} rows={5} {...form.register(name)} />
                  ) : spec.type === "select" ? (
                    <Controller
                      control={form.control}
                      name={name}
                      render={({ field }) => (
                        <Select
                          value={field.value || UNSET}
                          onValueChange={(v) => field.onChange(v === UNSET ? "" : v)}
                        >
                          <SelectTrigger id={id} className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value={UNSET}>
                              {spec.optionalChange ? "No change" : "None"}
                            </SelectItem>
                            {(spec.options?.(lookups) ?? []).map((o) => (
                              <SelectItem key={o.value} value={o.value}>
                                {o.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    />
                  ) : (
                    <Input
                      id={id}
                      type={spec.type === "date" ? "date" : "text"}
                      className={cn(spec.mono && "font-mono")}
                      {...form.register(name)}
                    />
                  )}
                </Field>
              );
            })}
          </FieldGroup>
          {errors.length > 0 && (
            <ul className="mt-4 list-disc pl-5 text-sm text-destructive">
              {errors.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
          )}
          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Approve with changes</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

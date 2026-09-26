import { zodResolver } from "@hookform/resolvers/zod";
import { Effect } from "effect";
import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { useLookups } from "@/app/queries";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  createDependency,
  type Dependency,
  updateDependency,
} from "@/services/dependencies/queries";
import { DEPENDENCY_STATUSES, type DependencyInput } from "@/services/dependencies/schema";
import { DEPENDENCY_KINDS, ISSUE_KEY_RE } from "@/services/proposals/schema";
import { useDependencyMutation } from "./use-dependencies";

const NONE = "__none__";

const Form = z
  .object({
    issueKey: z
      .string()
      .trim()
      .toUpperCase()
      .regex(ISSUE_KEY_RE, "Enter an issue key such as PAY-2"),
    kind: z.enum(DEPENDENCY_KINDS),
    label: z.string().trim().min(1, "Describe what the issue waits on"),
    ownerPersonId: z.string(),
    ownerTeamId: z.string(),
    externalRef: z.string(),
    externalUrl: z.union([
      z.literal(""),
      z.url({ protocol: /^https?$/, error: "Enter an http(s) URL" }),
    ]),
    status: z.enum(DEPENDENCY_STATUSES),
    expectedAt: z.string(),
    nextFollowupAt: z.string(),
    notesMd: z.string(),
  })
  .refine((v) => v.kind !== "incident" || v.externalRef.trim() !== "", {
    path: ["externalRef"],
    message: "An incident needs its number, e.g. INC0012345",
  });
type FormValues = z.input<typeof Form>;

const toForm = (d?: Partial<Dependency>): FormValues => ({
  issueKey: d?.issueKey ?? "",
  kind: d?.kind ?? "person",
  label: d?.label ?? "",
  ownerPersonId: d?.ownerPersonId ?? NONE,
  ownerTeamId: d?.ownerTeamId ?? NONE,
  externalRef: d?.externalRef ?? "",
  externalUrl: d?.externalUrl ?? "",
  status: d?.status ?? "open",
  expectedAt: d?.expectedAt ?? "",
  nextFollowupAt: d?.nextFollowupAt ?? "",
  notesMd: d?.notesMd ?? "",
});

const toInput = (v: z.output<typeof Form>): DependencyInput => ({
  issueKey: v.issueKey,
  kind: v.kind,
  label: v.label,
  ownerPersonId: v.ownerPersonId === NONE ? null : v.ownerPersonId,
  ownerTeamId: v.ownerTeamId === NONE ? null : v.ownerTeamId,
  externalRef: v.externalRef.trim() || null,
  externalUrl: v.externalUrl || null,
  status: v.status,
  expectedAt: v.expectedAt || null,
  nextFollowupAt: v.nextFollowupAt || null,
  notesMd: v.notesMd.trim() || null,
});

export function DependencyDialog({
  dependency,
  issueKey,
  open,
  onOpenChange,
}: {
  dependency?: Dependency;
  /** Prefill for a new dependency on a ticket. */
  issueKey?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const lookups = useLookups();
  const form = useForm<FormValues, unknown, z.output<typeof Form>>({
    resolver: zodResolver(Form),
    defaultValues: toForm(dependency ?? { issueKey }),
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the dialog opens.
  useEffect(() => {
    if (open) form.reset(toForm(dependency ?? { issueKey }));
  }, [open, dependency?.id, issueKey]);
  const save = useDependencyMutation(
    (v: z.output<typeof Form>) =>
      dependency
        ? Effect.as(updateDependency(dependency.id, toInput(v)), dependency.id)
        : createDependency(toInput(v)),
    dependency ? "Dependency updated" : "Dependency added",
  );
  const e = form.formState.errors;
  const select = (
    name: "kind" | "status" | "ownerPersonId" | "ownerTeamId",
    label: string,
    options: { value: string; label: string }[],
    withNone = false,
  ) => (
    <Controller
      control={form.control}
      name={name}
      render={({ field }) => (
        <Field>
          <FieldLabel htmlFor={`dep-${name}`}>{label}</FieldLabel>
          <Select value={field.value} onValueChange={field.onChange}>
            <SelectTrigger id={`dep-${name}`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {withNone && <SelectItem value={NONE}>None</SelectItem>}
              {options.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}
    />
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <form
          onSubmit={form.handleSubmit((v) =>
            save.mutate(v, { onSuccess: () => onOpenChange(false) }),
          )}
        >
          <DialogHeader className="mb-4">
            <DialogTitle>{dependency ? "Edit dependency" : "Add dependency"}</DialogTitle>
            <DialogDescription>
              Something a ticket waits on that is outside your control.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <div className="grid grid-cols-2 gap-4">
              <Field data-invalid={!!e.issueKey}>
                <FieldLabel htmlFor="dep-issue">Issue</FieldLabel>
                <Input
                  id="dep-issue"
                  list="dep-issue-keys"
                  className="font-mono uppercase"
                  {...form.register("issueKey")}
                />
                <datalist id="dep-issue-keys">
                  {lookups.tickets.slice(0, 500).map((t) => (
                    <option key={t.key} value={t.key}>
                      {t.summary}
                    </option>
                  ))}
                </datalist>
                <FieldError errors={[e.issueKey]} />
              </Field>
              {select(
                "kind",
                "Waiting on",
                DEPENDENCY_KINDS.map((k) => ({ value: k, label: k })),
              )}
            </div>
            <Field data-invalid={!!e.label}>
              <FieldLabel htmlFor="dep-label">What</FieldLabel>
              <Input
                id="dep-label"
                placeholder="Firewall change from Network"
                {...form.register("label")}
              />
              <FieldError errors={[e.label]} />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              {select(
                "ownerPersonId",
                "Owner (person)",
                lookups.people.map((p) => ({ value: p.id, label: p.displayName })),
                true,
              )}
              {select(
                "ownerTeamId",
                "Owner (team)",
                lookups.teams.map((t) => ({ value: t.id, label: t.name })),
                true,
              )}
              <Field data-invalid={!!e.externalRef}>
                <FieldLabel htmlFor="dep-ref">Reference</FieldLabel>
                <Input
                  id="dep-ref"
                  placeholder="INC0012345"
                  className="font-mono"
                  {...form.register("externalRef")}
                />
                <FieldError errors={[e.externalRef]} />
              </Field>
              <Field data-invalid={!!e.externalUrl}>
                <FieldLabel htmlFor="dep-url">URL</FieldLabel>
                <Input
                  id="dep-url"
                  placeholder="https://servicenow.example.com/..."
                  {...form.register("externalUrl")}
                />
                <FieldError errors={[e.externalUrl]} />
              </Field>
              {select(
                "status",
                "Status",
                DEPENDENCY_STATUSES.map((s) => ({ value: s, label: s })),
              )}
              <div />
              <Field>
                <FieldLabel htmlFor="dep-expected">Expected by</FieldLabel>
                <Input id="dep-expected" type="date" {...form.register("expectedAt")} />
              </Field>
              <Field>
                <FieldLabel htmlFor="dep-next">Next follow-up</FieldLabel>
                <Input id="dep-next" type="date" {...form.register("nextFollowupAt")} />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="dep-notes">Notes</FieldLabel>
              <Textarea
                id="dep-notes"
                rows={3}
                placeholder="Markdown"
                {...form.register("notesMd")}
              />
            </Field>
          </FieldGroup>
          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

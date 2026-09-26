import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Sparkles } from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { useLookups } from "@/app/queries";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { DRAFT_CHANNELS } from "@/services/comms";
import { listDependencies } from "@/services/dependencies/queries";
import { MESSAGE_INTENTS } from "@/services/proposals/schema";
import { type Recipient, RecipientPicker, TicketPicker } from "./pickers";
import { useCreateDraft } from "./use-drafts";

export const INTENT_LABELS: Record<(typeof MESSAGE_INTENTS)[number], string> = {
  chase: "Chase",
  status_update: "Status update",
  request: "Request",
  escalation: "Escalation",
  fyi: "FYI",
  thank_you: "Thank you",
};

const NO_DEPENDENCY = "none";

const Form = z.object({
  kind: z.enum(DRAFT_CHANNELS),
  intent: z.enum(MESSAGE_INTENTS),
  recipient: z
    .object({ type: z.enum(["person", "team"]), id: z.string() })
    .nullable()
    .refine((r) => r !== null, "Choose who the message is for"),
  issueKeys: z.array(z.string()),
  dependencyId: z.string(),
  notes: z.string().trim().max(4000),
});
type FormInput = z.input<typeof Form>;

/** New draft (FR-6.1): who, why, about what, and what it should say. */
export function DraftComposer() {
  const lookups = useLookups();
  const deps = useQuery({
    queryKey: queryKeys.dependencyList(false),
    queryFn: ({ signal }) => run(listDependencies({}), signal),
  });
  const create = useCreateDraft();
  const form = useForm<FormInput, unknown, z.output<typeof Form>>({
    resolver: zodResolver(Form),
    defaultValues: {
      kind: "teams",
      intent: "chase",
      recipient: null,
      issueKeys: [],
      dependencyId: NO_DEPENDENCY,
      notes: "",
    },
  });

  const pickRecipient = (r: Recipient) => {
    form.setValue("recipient", r, { shouldValidate: true, shouldDirty: true });
    const person = r?.type === "person" ? lookups.person.get(r.id) : undefined;
    if (person?.profile.preferredChannel === "email") form.setValue("kind", "email");
    if (person?.profile.preferredChannel === "teams") form.setValue("kind", "teams");
  };

  // Picking a dependency fills in its ticket and owner, which the draft is about anyway.
  const pickDependency = (id: string) => {
    form.setValue("dependencyId", id, { shouldDirty: true });
    const dep = deps.data?.find((d) => d.id === id);
    if (!dep) return;
    const keys = form.getValues("issueKeys");
    if (!keys.includes(dep.issueKey)) form.setValue("issueKeys", [...keys, dep.issueKey]);
    if (!form.getValues("recipient")) {
      if (dep.ownerPersonId) pickRecipient({ type: "person", id: dep.ownerPersonId });
      else if (dep.ownerTeamId) pickRecipient({ type: "team", id: dep.ownerTeamId });
    }
  };

  const onSubmit = form.handleSubmit((v) =>
    create.mutate({
      kind: v.kind,
      intent: v.intent,
      recipientPersonId: v.recipient?.type === "person" ? v.recipient.id : null,
      recipientTeamId: v.recipient?.type === "team" ? v.recipient.id : null,
      issueKeys: v.issueKeys,
      dependencyId: v.dependencyId === NO_DEPENDENCY ? null : v.dependencyId,
      notes: v.notes,
    }),
  );

  return (
    <form onSubmit={onSubmit} className="flex max-w-2xl flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Controller
          control={form.control}
          name="recipient"
          render={({ field, fieldState }) => (
            <Field data-invalid={!!fieldState.error}>
              <FieldLabel htmlFor="recipient">To</FieldLabel>
              <RecipientPicker
                id="recipient"
                people={lookups.people}
                teams={lookups.teams}
                value={field.value}
                onChange={pickRecipient}
              />
              <FieldError errors={[fieldState.error]} />
            </Field>
          )}
        />
        <Controller
          control={form.control}
          name="intent"
          render={({ field }) => (
            <Field>
              <FieldLabel htmlFor="intent">Purpose</FieldLabel>
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger id="intent" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MESSAGE_INTENTS.map((i) => (
                    <SelectItem key={i} value={i}>
                      {INTENT_LABELS[i]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
        />
      </div>
      <Controller
        control={form.control}
        name="kind"
        render={({ field }) => (
          <Field>
            <FieldLabel>Channel</FieldLabel>
            <ToggleGroup
              type="single"
              variant="outline"
              value={field.value}
              onValueChange={(v) => v && field.onChange(v)}
              className="w-fit"
            >
              <ToggleGroupItem value="teams">Teams</ToggleGroupItem>
              <ToggleGroupItem value="email">Email</ToggleGroupItem>
            </ToggleGroup>
          </Field>
        )}
      />
      <Controller
        control={form.control}
        name="dependencyId"
        render={({ field }) => (
          <Field>
            <FieldLabel htmlFor="dependency">Waiting on</FieldLabel>
            <Select value={field.value} onValueChange={pickDependency}>
              <SelectTrigger id="dependency" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_DEPENDENCY}>Nothing in particular</SelectItem>
                {(deps.data ?? []).map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.issueKey}: {d.label}
                    {d.externalRef ? ` (${d.externalRef})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>
              A chase names what was asked and when; marking it sent logs the follow-up.
            </FieldDescription>
          </Field>
        )}
      />
      <Controller
        control={form.control}
        name="issueKeys"
        render={({ field }) => (
          <Field>
            <FieldLabel htmlFor="tickets">Tickets</FieldLabel>
            <TicketPicker
              id="tickets"
              tickets={lookups.tickets}
              value={field.value}
              onChange={field.onChange}
            />
          </Field>
        )}
      />
      <Field data-invalid={!!form.formState.errors.notes}>
        <FieldLabel htmlFor="notes">What should it say?</FieldLabel>
        <Textarea
          id="notes"
          rows={4}
          placeholder="e.g. Ask for an ETA on the fix; we need it before Friday's release."
          {...form.register("notes")}
        />
        <FieldError errors={[form.formState.errors.notes]} />
      </Field>
      <Button type="submit" className="w-fit" disabled={create.isPending}>
        {create.isPending ? <Loader2 className="animate-spin" /> : <Sparkles />}
        Write draft
      </Button>
    </form>
  );
}

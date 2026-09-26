import { zodResolver } from "@hookform/resolvers/zod";
import { Effect } from "effect";
import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { useTeams } from "@/app/queries";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { createPerson, type Person, updatePerson } from "@/services/directory/queries";
import {
  CHANNELS,
  DETAIL,
  FORMALITY,
  type PersonInput,
  RESPONSIVENESS,
} from "@/services/directory/schema";
import { useDirectoryMutation } from "./use-directory";

const UNSET = "__unset__";

const Form = z.object({
  displayName: z.string().trim().min(1, "Name is required"),
  jiraUsername: z.string(),
  email: z.union([z.literal(""), z.email("Enter a valid email")]),
  title: z.string(),
  teamId: z.string(),
  responsibilities: z.string(),
  tone: z.string().max(200),
  formality: z.string(),
  detail: z.string(),
  responsiveness: z.string(),
  preferredChannel: z.string(),
  language: z.string().max(50),
  notesMd: z.string(),
});
type FormValues = z.infer<typeof Form>;

function toForm(p?: Partial<Person>): FormValues {
  const profile = (p?.profile ?? {}) as Record<string, string | undefined>;
  return {
    displayName: p?.displayName ?? "",
    jiraUsername: p?.jiraUsername ?? "",
    email: p?.email ?? "",
    title: p?.title ?? "",
    teamId: p?.teamId ?? UNSET,
    responsibilities: p?.responsibilities ?? "",
    tone: profile.tone ?? "",
    formality: profile.formality ?? UNSET,
    detail: profile.detail ?? UNSET,
    responsiveness: profile.responsiveness ?? UNSET,
    preferredChannel: profile.preferredChannel ?? UNSET,
    language: profile.language ?? "",
    notesMd: p?.notesMd ?? "",
  };
}

function toInput(v: FormValues): PersonInput {
  const opt = (x: string) => (x === UNSET || x.trim() === "" ? undefined : x.trim());
  return {
    displayName: v.displayName,
    jiraUsername: v.jiraUsername,
    email: v.email,
    title: v.title,
    teamId: v.teamId === UNSET ? null : v.teamId,
    responsibilities: v.responsibilities,
    notesMd: v.notesMd,
    profile: {
      tone: opt(v.tone),
      formality: opt(v.formality) as (typeof FORMALITY)[number] | undefined,
      detail: opt(v.detail) as (typeof DETAIL)[number] | undefined,
      responsiveness: opt(v.responsiveness) as (typeof RESPONSIVENESS)[number] | undefined,
      preferredChannel: opt(v.preferredChannel) as (typeof CHANNELS)[number] | undefined,
      language: opt(v.language),
    },
  };
}

type EnumField = "formality" | "detail" | "responsiveness" | "preferredChannel";

function EnumSelect({
  form,
  name,
  label,
  options,
}: {
  form: ReturnType<typeof useForm<FormValues>>;
  name: EnumField | "teamId";
  label: string;
  options: readonly { value: string; label: string }[];
}) {
  return (
    <Controller
      control={form.control}
      name={name}
      render={({ field }) => (
        <Field>
          <FieldLabel htmlFor={`person-${name}`}>{label}</FieldLabel>
          <Select value={field.value} onValueChange={field.onChange}>
            <SelectTrigger id={`person-${name}`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNSET}>{name === "teamId" ? "No team" : "Not known"}</SelectItem>
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
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const opts = (values: readonly string[]) => values.map((v) => ({ value: v, label: cap(v) }));

export function PersonDialog({
  person,
  initial,
  open,
  onOpenChange,
  onSaved,
}: {
  person?: Person;
  /** Prefill for a new contact, e.g. from a Jira user. */
  initial?: Partial<Person>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (id: string) => void;
}) {
  const teams = useTeams({ enabled: open });
  const form = useForm<FormValues>({
    resolver: zodResolver(Form),
    defaultValues: toForm(person ?? initial),
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the dialog opens for a given person.
  useEffect(() => {
    if (open) form.reset(toForm(person ?? initial));
  }, [open, person?.id]);
  const save = useDirectoryMutation(
    (v: FormValues) =>
      person ? Effect.as(updatePerson(person.id, toInput(v)), person.id) : createPerson(toInput(v)),
    person ? "Contact updated" : "Contact added",
  );
  const e = form.formState.errors;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <form
          onSubmit={form.handleSubmit((v) =>
            save.mutate(v, {
              onSuccess: (id) => {
                onOpenChange(false);
                onSaved?.(id);
              },
            }),
          )}
        >
          <DialogHeader className="mb-4">
            <DialogTitle>{person ? `Edit ${person.displayName}` : "Add contact"}</DialogTitle>
            <DialogDescription>
              The communication profile shapes the tone of drafts to this person.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <div className="grid grid-cols-2 gap-4">
              <Field data-invalid={!!e.displayName}>
                <FieldLabel htmlFor="person-name">Name</FieldLabel>
                <Input id="person-name" {...form.register("displayName")} />
                <FieldError errors={[e.displayName]} />
              </Field>
              <Field>
                <FieldLabel htmlFor="person-title">Title</FieldLabel>
                <Input id="person-title" placeholder="Tech lead" {...form.register("title")} />
              </Field>
              <Field data-invalid={!!e.email}>
                <FieldLabel htmlFor="person-email">Email</FieldLabel>
                <Input id="person-email" type="email" {...form.register("email")} />
                <FieldError errors={[e.email]} />
              </Field>
              <Field>
                <FieldLabel htmlFor="person-jira">Jira user</FieldLabel>
                <Input id="person-jira" className="font-mono" {...form.register("jiraUsername")} />
                <FieldDescription>
                  Username on Data Center, account ID on Cloud. Filled in when you add someone from
                  Jira.
                </FieldDescription>
              </Field>
              <EnumSelect
                form={form}
                name="teamId"
                label="Team"
                options={(teams.data ?? []).map((t) => ({ value: t.id, label: t.name }))}
              />
            </div>
            <Field>
              <FieldLabel htmlFor="person-resp">Responsibilities</FieldLabel>
              <Textarea id="person-resp" rows={2} {...form.register("responsibilities")} />
            </Field>
            <FieldSet>
              <FieldLegend variant="label">Communication profile</FieldLegend>
              <div className="grid grid-cols-3 gap-4">
                <EnumSelect
                  form={form}
                  name="formality"
                  label="Formality"
                  options={opts(FORMALITY)}
                />
                <EnumSelect form={form} name="detail" label="Detail level" options={opts(DETAIL)} />
                <EnumSelect
                  form={form}
                  name="responsiveness"
                  label="Responsiveness"
                  options={opts(RESPONSIVENESS)}
                />
                <EnumSelect
                  form={form}
                  name="preferredChannel"
                  label="Preferred channel"
                  options={opts(CHANNELS)}
                />
                <Field>
                  <FieldLabel htmlFor="person-language">Language</FieldLabel>
                  <Input
                    id="person-language"
                    placeholder="English"
                    {...form.register("language")}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="person-tone">Tone</FieldLabel>
                  <Input
                    id="person-tone"
                    placeholder="Direct, friendly"
                    {...form.register("tone")}
                  />
                </Field>
              </div>
            </FieldSet>
            <Field>
              <FieldLabel htmlFor="person-notes">Notes</FieldLabel>
              <Textarea
                id="person-notes"
                rows={4}
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

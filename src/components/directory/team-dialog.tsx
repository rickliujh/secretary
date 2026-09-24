import { zodResolver } from "@hookform/resolvers/zod";
import { Effect } from "effect";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { createTeam, type Team, updateTeam } from "@/services/directory/queries";
import { useDirectoryMutation } from "./use-directory";

const urlLines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

const Form = z
  .object({
    name: z.string().trim().min(1, "Name is required"),
    function: z.string(),
    contactFor: z.string(),
    channel: z.string(),
    escalationPath: z.string(),
    confluenceUrls: z.string(),
    notesMd: z.string(),
  })
  .superRefine((v, ctx) => {
    const bad = urlLines(v.confluenceUrls).filter(
      (u) => !z.url({ protocol: /^https?$/ }).safeParse(u).success,
    );
    if (bad.length)
      ctx.addIssue({
        code: "custom",
        path: ["confluenceUrls"],
        message: `Not URLs: ${bad.join(", ")}`,
      });
  });
type FormValues = z.infer<typeof Form>;

const toForm = (t?: Team): FormValues => ({
  name: t?.name ?? "",
  function: t?.function ?? "",
  contactFor: t?.contactFor ?? "",
  channel: t?.channel ?? "",
  escalationPath: t?.escalationPath ?? "",
  confluenceUrls: (t?.confluenceUrls ?? []).join("\n"),
  notesMd: t?.notesMd ?? "",
});

export function TeamDialog({
  team,
  open,
  onOpenChange,
  onSaved,
}: {
  team?: Team;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onSaved?: (id: string) => void;
}) {
  const form = useForm<FormValues>({ resolver: zodResolver(Form), defaultValues: toForm(team) });
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the dialog opens for a given team.
  useEffect(() => {
    if (open) form.reset(toForm(team));
  }, [open, team?.id]);
  const save = useDirectoryMutation(
    (v: FormValues) => {
      const input = { ...v, confluenceUrls: urlLines(v.confluenceUrls) };
      return team ? Effect.as(updateTeam(team.id, input), team.id) : createTeam(input);
    },
    team ? "Team updated" : "Team added",
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
            <DialogTitle>{team ? `Edit ${team.name}` : "Add team"}</DialogTitle>
            <DialogDescription>What the team does and how to reach them.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <div className="grid grid-cols-2 gap-4">
              <Field data-invalid={!!e.name}>
                <FieldLabel htmlFor="team-name">Name</FieldLabel>
                <Input id="team-name" {...form.register("name")} />
                <FieldError errors={[e.name]} />
              </Field>
              <Field>
                <FieldLabel htmlFor="team-channel">Primary channel</FieldLabel>
                <Input
                  id="team-channel"
                  placeholder="#payments-help on Teams"
                  {...form.register("channel")}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="team-function">Function</FieldLabel>
              <Input
                id="team-function"
                placeholder="Owns invoicing and ledger exports"
                {...form.register("function")}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="team-contact-for">Contact them for</FieldLabel>
              <Textarea id="team-contact-for" rows={2} {...form.register("contactFor")} />
            </Field>
            <Field>
              <FieldLabel htmlFor="team-escalation">Escalation path</FieldLabel>
              <Textarea id="team-escalation" rows={2} {...form.register("escalationPath")} />
            </Field>
            <Field data-invalid={!!e.confluenceUrls}>
              <FieldLabel htmlFor="team-urls">Confluence links</FieldLabel>
              <Textarea
                id="team-urls"
                rows={2}
                className="font-mono text-xs"
                {...form.register("confluenceUrls")}
              />
              <FieldDescription>
                One URL per line. Use "Import from Confluence" to store a page's content.
              </FieldDescription>
              <FieldError errors={[e.confluenceUrls]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="team-notes">Notes</FieldLabel>
              <Textarea
                id="team-notes"
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

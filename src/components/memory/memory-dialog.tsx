import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { useLookups } from "@/components/inbox/use-inbox";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
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
  createMemory,
  EDITABLE_KINDS,
  type MemoryView,
  updateMemory,
  WEIGHTS,
} from "@/services/memory/queries";
import { useMemoryMutation } from "./use-memory";

const KIND_HELP: Record<(typeof EDITABLE_KINDS)[number], string> = {
  rule: "How to handle work, e.g. “Anything about the billing migration goes under PAY-1.”",
  fact: "Something true, e.g. “Platform deploys on Tuesdays.”",
  preference: "How you like things, e.g. “Keep chases to two sentences.”",
};

const NONE = "none";

const Form = z
  .object({
    kind: z.enum(EDITABLE_KINDS),
    content: z.string().trim().min(1, "Write the rule, fact or preference").max(2000),
    about: z.enum([NONE, "person", "team", "issue"]),
    subjectId: z.string().trim(),
    weight: z.enum(["low", "normal", "high"]),
  })
  .refine((f) => f.about === NONE || f.subjectId !== "", {
    path: ["subjectId"],
    message: "Choose who or what it is about",
  })
  .refine((f) => f.about !== "issue" || /^[A-Z][A-Z0-9_]+-\d+$/.test(f.subjectId), {
    path: ["subjectId"],
    message: "Use an issue key like PAY-12",
  });
type FormValues = z.infer<typeof Form>;

const weightName = (w: number): FormValues["weight"] =>
  w <= WEIGHTS.low ? "low" : w >= WEIGHTS.high ? "high" : "normal";

/** Add or edit a rule, fact or preference (FR-7.1). */
export function MemoryDialog({
  open,
  onOpenChange,
  memory,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  memory?: MemoryView | null;
}) {
  const { people, teams } = useLookups();
  const form = useForm<FormValues>({
    resolver: zodResolver(Form),
    defaultValues: { kind: "rule", content: "", about: NONE, subjectId: "", weight: "normal" },
  });
  useEffect(() => {
    if (!open) return;
    const known = ["person", "team", "issue"].includes(memory?.subjectType ?? "");
    form.reset({
      kind: memory && memory.kind !== "example" ? memory.kind : "rule",
      content: memory?.content ?? "",
      about: known ? (memory?.subjectType as FormValues["about"]) : NONE,
      subjectId: known ? (memory?.subjectId ?? "") : "",
      weight: weightName(memory?.weight ?? 1),
    });
  }, [open, memory, form]);

  const save = useMemoryMutation(
    (v: FormValues) => {
      const input = {
        kind: v.kind,
        content: v.content,
        subjectType: v.about === NONE ? null : v.about,
        subjectId: v.about === NONE ? null : v.subjectId,
        weight: WEIGHTS[v.weight],
      };
      return memory ? updateMemory(memory.id, input) : createMemory(input);
    },
    memory ? "Saved" : "Remembered",
  );
  const about = form.watch("about");
  const kind = form.watch("kind");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form
          onSubmit={form.handleSubmit((v) =>
            save.mutate(v, { onSuccess: () => onOpenChange(false) }),
          )}
          className="flex flex-col gap-4"
        >
          <DialogHeader>
            <DialogTitle>{memory ? "Edit memory" : "Add memory"}</DialogTitle>
            <DialogDescription>
              The secretary uses this when it reads your messages and writes drafts.
            </DialogDescription>
          </DialogHeader>
          <Controller
            control={form.control}
            name="kind"
            render={({ field }) => (
              <Field>
                <FieldLabel htmlFor="memory-kind">Kind</FieldLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="memory-kind" className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EDITABLE_KINDS.map((k) => (
                      <SelectItem key={k} value={k} className="capitalize">
                        {k}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <FieldDescription>{KIND_HELP[kind]}</FieldDescription>
              </Field>
            )}
          />
          <Field data-invalid={!!form.formState.errors.content}>
            <FieldLabel htmlFor="memory-content">Text</FieldLabel>
            <Textarea id="memory-content" rows={3} {...form.register("content")} />
            <FieldError errors={[form.formState.errors.content]} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Controller
              control={form.control}
              name="about"
              render={({ field }) => (
                <Field>
                  <FieldLabel htmlFor="memory-about">About</FieldLabel>
                  <Select
                    value={field.value}
                    onValueChange={(v) => {
                      field.onChange(v);
                      form.setValue("subjectId", "");
                    }}
                  >
                    <SelectTrigger id="memory-about" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>Anything</SelectItem>
                      <SelectItem value="person">A person</SelectItem>
                      <SelectItem value="team">A team</SelectItem>
                      <SelectItem value="issue">A ticket</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
              )}
            />
            {about !== NONE && (
              <Controller
                control={form.control}
                name="subjectId"
                render={({ field, fieldState }) => (
                  <Field data-invalid={!!fieldState.error}>
                    <FieldLabel htmlFor="memory-subject">
                      {about === "issue" ? "Ticket key" : about === "team" ? "Team" : "Person"}
                    </FieldLabel>
                    {about === "issue" ? (
                      <Input
                        id="memory-subject"
                        placeholder="PAY-12"
                        value={field.value}
                        onChange={(e) => field.onChange(e.target.value.toUpperCase())}
                      />
                    ) : (
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger id="memory-subject" className="w-full">
                          <SelectValue placeholder="Choose" />
                        </SelectTrigger>
                        <SelectContent>
                          {(about === "team"
                            ? teams.map((t) => ({ id: t.id, name: t.name }))
                            : people.map((p) => ({ id: p.id, name: p.displayName }))
                          ).map((o) => (
                            <SelectItem key={o.id} value={o.id}>
                              {o.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    <FieldError errors={[fieldState.error]} />
                  </Field>
                )}
              />
            )}
          </div>
          <Controller
            control={form.control}
            name="weight"
            render={({ field }) => (
              <Field>
                <FieldLabel htmlFor="memory-weight">Importance</FieldLabel>
                <Select value={field.value} onValueChange={field.onChange}>
                  <SelectTrigger id="memory-weight" className="w-40">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="low">Low</SelectItem>
                    <SelectItem value="normal">Normal</SelectItem>
                    <SelectItem value="high">High</SelectItem>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  High-importance memories are picked first when space is short.
                </FieldDescription>
              </Field>
            )}
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
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

import { zodResolver } from "@hookform/resolvers/zod";
import { useQuery } from "@tanstack/react-query";
import { Effect } from "effect";
import { UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { JiraClient } from "@/services/jira";
import { epicsInProject, type TicketDetail } from "@/services/tickets/queries";
import { useExecute } from "./use-execute";

type Issue = TicketDetail["issue"];

export function TransitionSelect({ issue }: { issue: Issue }) {
  const execute = useExecute();
  const transitions = useQuery({
    queryKey: queryKeys.transitions(issue.key),
    queryFn: ({ signal }) =>
      run(
        Effect.flatMap(JiraClient, (j) => j.getTransitions(issue.key)),
        signal,
      ),
    staleTime: 0,
  });
  return (
    <Select
      value=""
      disabled={execute.isPending}
      onValueChange={(id) => {
        const t = transitions.data?.find((x) => x.id === id);
        execute.mutate({
          kind: "transition",
          issueKey: issue.key,
          transitionId: id,
          transitionName: t?.name,
        });
      }}
    >
      <SelectTrigger size="sm" className="w-44" aria-label="Transition">
        <SelectValue placeholder={transitions.isPending ? "Loading..." : "Move to..."} />
      </SelectTrigger>
      <SelectContent>
        {(transitions.data ?? []).map((t) => (
          <SelectItem key={t.id} value={t.id}>
            {t.name}
            {t.name !== t.to.name && <span className="text-muted-foreground"> → {t.to.name}</span>}
          </SelectItem>
        ))}
        {transitions.isError && (
          <SelectItem value="__error" disabled>
            Could not load transitions
          </SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}

const NO_EPIC = "__none__";

export function EpicSelect({ issue }: { issue: Issue }) {
  const execute = useExecute();
  const epics = useQuery({
    queryKey: queryKeys.epics(issue.projectKey),
    queryFn: ({ signal }) => run(epicsInProject(issue.projectKey), signal),
  });
  if (issue.issueType === "Epic" || issue.isSubtask) return null;
  return (
    <Select
      value={issue.epicKey ?? NO_EPIC}
      disabled={execute.isPending}
      onValueChange={(v) =>
        execute.mutate({ kind: "set_epic", issueKey: issue.key, epicKey: v === NO_EPIC ? null : v })
      }
    >
      <SelectTrigger size="sm" className="w-56" aria-label="Epic">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NO_EPIC}>No epic</SelectItem>
        {issue.epicKey && !epics.data?.some((e) => e.key === issue.epicKey) && (
          <SelectItem value={issue.epicKey}>{issue.epicKey}</SelectItem>
        )}
        {(epics.data ?? []).map((e) => (
          <SelectItem key={e.key} value={e.key}>
            {e.key} {e.epicName ?? e.summary}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function AssignButton({ issue }: { issue: Issue }) {
  const execute = useExecute();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);
  const users = useQuery({
    queryKey: ["jira", "assignable", issue.key, debounced],
    queryFn: ({ signal }) =>
      run(
        Effect.flatMap(JiraClient, (j) => j.assignableUsers(issue.key, debounced)),
        signal,
      ),
    enabled: open && debounced.length >= 2,
  });
  const assign = (username: string | null) => {
    setOpen(false);
    execute.mutate({ kind: "assign", issueKey: issue.key, username });
  };
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        disabled={execute.isPending}
      >
        <UserRound /> Assign
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="overflow-hidden p-0" showCloseButton={false}>
          <DialogHeader className="sr-only">
            <DialogTitle>Assign {issue.key}</DialogTitle>
            <DialogDescription>Search assignable users</DialogDescription>
          </DialogHeader>
          {/* Jira does the matching, so cmdk must not filter the results again. */}
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Name or username (2+ characters)"
              value={text}
              onValueChange={setText}
            />
            <CommandList>
              <CommandEmpty>
                {debounced.length < 2
                  ? "Type to search."
                  : users.isPending
                    ? "Searching..."
                    : "No users."}
              </CommandEmpty>
              <CommandGroup>
                {issue.assignee && (
                  <CommandItem value="__unassign" onSelect={() => assign(null)}>
                    Unassign
                  </CommandItem>
                )}
                {(users.data ?? []).map((u) => (
                  <CommandItem key={u.id} value={u.id} onSelect={() => assign(u.id)}>
                    {u.displayName}{" "}
                    <span className="text-muted-foreground">{u.emailAddress ?? u.name ?? ""}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  );
}

const EditForm = z.object({
  summary: z.string().trim().min(1, "Summary is required"),
  priority: z.string(),
  dueDate: z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]),
  descriptionWiki: z.string(),
});
type EditValues = z.infer<typeof EditForm>;

export function EditDialog({
  issue,
  open,
  onOpenChange,
}: {
  issue: Issue;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const execute = useExecute();
  const priorities = useQuery({
    queryKey: queryKeys.priorities,
    queryFn: ({ signal }) =>
      run(
        Effect.flatMap(JiraClient, (j) => j.priorities),
        signal,
      ),
    enabled: open,
    staleTime: 60 * 60 * 1000,
  });
  const initial: EditValues = {
    summary: issue.summary,
    priority: issue.priority ?? "",
    dueDate: issue.dueDate ?? "",
    descriptionWiki: (issue.description ?? "").replace(/\r\n/g, "\n"),
  };
  const form = useForm<EditValues>({ resolver: zodResolver(EditForm), defaultValues: initial });
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the dialog opens or the issue changes.
  useEffect(() => {
    if (open) form.reset(initial);
  }, [open, issue.key, issue.updated]);

  const onSubmit = form.handleSubmit((v) => {
    const fields: Record<string, string | null> = {};
    if (v.summary !== initial.summary) fields.summary = v.summary;
    if (v.priority && v.priority !== initial.priority) fields.priority = v.priority;
    if (v.dueDate !== initial.dueDate) fields.dueDate = v.dueDate || null;
    if (v.descriptionWiki !== initial.descriptionWiki)
      fields.descriptionWiki = v.descriptionWiki || null;
    if (Object.keys(fields).length === 0) return onOpenChange(false);
    execute.mutate(
      { kind: "update_fields", issueKey: issue.key, fields },
      { onSuccess: () => onOpenChange(false) },
    );
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={onSubmit}>
          <DialogHeader className="mb-4">
            <DialogTitle>Edit {issue.key}</DialogTitle>
            <DialogDescription>Only changed fields are sent to Jira.</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={!!form.formState.errors.summary}>
              <FieldLabel htmlFor="edit-summary">Summary</FieldLabel>
              <Input id="edit-summary" {...form.register("summary")} />
              <FieldError errors={[form.formState.errors.summary]} />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Controller
                control={form.control}
                name="priority"
                render={({ field }) => (
                  <Field>
                    <FieldLabel htmlFor="edit-priority">Priority</FieldLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger id="edit-priority" className="w-full">
                        <SelectValue placeholder="None" />
                      </SelectTrigger>
                      <SelectContent>
                        {(
                          priorities.data ??
                          (initial.priority ? [{ id: "current", name: initial.priority }] : [])
                        ).map((p) => (
                          <SelectItem key={p.name} value={p.name}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                )}
              />
              <Field>
                <FieldLabel htmlFor="edit-due">Due date</FieldLabel>
                <Input id="edit-due" type="date" {...form.register("dueDate")} />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="edit-description">Description</FieldLabel>
              <Textarea
                id="edit-description"
                rows={12}
                className="font-mono text-xs"
                {...form.register("descriptionWiki")}
              />
              <FieldDescription>
                Jira wiki markup, edited as stored so panels and tables are not lost.
              </FieldDescription>
            </Field>
          </FieldGroup>
          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={execute.isPending}>
              {execute.isPending ? "Saving..." : "Save to Jira"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CommentComposer({ issue }: { issue: Issue }) {
  const execute = useExecute();
  const [text, setText] = useState("");
  const send = () =>
    execute.mutate(
      { kind: "add_comment", issueKey: issue.key, bodyMarkdown: text },
      { onSuccess: () => setText("") },
    );
  return (
    <div className="flex flex-col gap-2">
      <Textarea
        aria-label="New comment"
        placeholder="Add a comment (Markdown)"
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && text.trim()) send();
        }}
      />
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          Markdown is converted to Jira wiki markup. Ctrl+Enter sends.
        </span>
        <Button size="sm" disabled={!text.trim() || execute.isPending} onClick={send}>
          {execute.isPending ? "Sending..." : "Comment"}
        </Button>
      </div>
    </div>
  );
}

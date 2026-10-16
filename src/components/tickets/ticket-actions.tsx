import { useQuery } from "@tanstack/react-query";
import { Effect } from "effect";
import { UserRound } from "lucide-react";
import { useEffect, useState } from "react";
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
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
            {e.key} {e.epicName || e.summary}
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
    queryKey: queryKeys.assignableUsers(issue.key, debounced),
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

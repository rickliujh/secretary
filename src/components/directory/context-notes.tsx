import { useQuery } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Effect } from "effect";
import { ExternalLink, FileDown, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { Markdown } from "@/components/markdown";
import { Badge } from "@/components/ui/badge";
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
import { Textarea } from "@/components/ui/textarea";
import { relativeTime } from "@/lib/time";
import {
  addNote,
  type ContextNote,
  deleteNote,
  importConfluencePage,
  listNotes,
  updateNote,
} from "@/services/directory/notes";
import type { Subject } from "@/services/directory/schema";
import { ConfluenceImportDialog } from "./confluence-import-dialog";
import { useDirectoryMutation } from "./use-directory";

type NoteForm = { title: string; bodyMd: string };

function NoteDialog({
  subject,
  note,
  open,
  onOpenChange,
}: {
  subject: Subject;
  note?: ContextNote;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const form = useForm<NoteForm>({ defaultValues: { title: "", bodyMd: "" } });
  useEffect(() => {
    if (open) form.reset({ title: note?.title ?? "", bodyMd: note?.bodyMd ?? "" });
  }, [open, note, form]);
  const save = useDirectoryMutation(
    (v: NoteForm) =>
      note ? Effect.asVoid(updateNote(note.id, v)) : Effect.asVoid(addNote(subject, v)),
    note ? "Note updated" : "Note added",
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <form
          onSubmit={form.handleSubmit((v) =>
            save.mutate(v, { onSuccess: () => onOpenChange(false) }),
          )}
        >
          <DialogHeader className="mb-4">
            <DialogTitle>{note ? "Edit note" : "Add note"}</DialogTitle>
            <DialogDescription>
              Markdown. Notes are used as context when the secretary drafts and triages.
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={!!form.formState.errors.title}>
              <FieldLabel htmlFor="note-title">Title</FieldLabel>
              <Input
                id="note-title"
                {...form.register("title", {
                  validate: (v) => v.trim() !== "" || "Title is required",
                })}
              />
              <FieldError errors={[form.formState.errors.title]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="note-body">Body</FieldLabel>
              <Textarea
                id="note-body"
                rows={12}
                className="font-mono text-xs"
                {...form.register("bodyMd")}
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

function NoteCard({
  note,
  subject,
  onEdit,
}: {
  note: ContextNote;
  subject: Subject;
  onEdit: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const remove = useDirectoryMutation(() => deleteNote(note.id), "Note deleted");
  const refresh = useDirectoryMutation(
    () => importConfluencePage(note.sourceId ?? "", subject),
    (r) => `Re-imported "${r.title}" (version ${r.version})`,
  );
  return (
    <article className="rounded-lg border">
      <header className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-sm font-medium"
          onClick={() => setExpanded((e) => !e)}
        >
          {note.title}
        </button>
        {note.sourceId ? (
          <Badge variant="outline">Confluence v{note.sourceVersion}</Badge>
        ) : (
          <Badge variant="secondary">Note</Badge>
        )}
        <span className="text-xs text-muted-foreground">{relativeTime(note.importedAt)}</span>
        {note.sourceUrl && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Open source"
            onClick={() => void openUrl(note.sourceUrl ?? "")}
          >
            <ExternalLink />
          </Button>
        )}
        {note.sourceId ? (
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Re-import from Confluence"
            disabled={refresh.isPending}
            onClick={() => refresh.mutate(undefined)}
          >
            <RefreshCw className={refresh.isPending ? "animate-spin" : undefined} />
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            aria-label="Edit note"
            onClick={onEdit}
          >
            <Pencil />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-destructive"
          aria-label="Delete note"
          onClick={() => remove.mutate(undefined)}
        >
          <Trash2 />
        </Button>
      </header>
      <div
        className={
          expanded ? "border-t px-3 py-2" : "relative max-h-24 overflow-hidden border-t px-3 py-2"
        }
      >
        <Markdown>{note.bodyMd}</Markdown>
        {!expanded && (
          <button
            type="button"
            className="absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background text-xs text-muted-foreground"
            onClick={() => setExpanded(true)}
          >
            Show more
          </button>
        )}
      </div>
    </article>
  );
}

/** Notes and imported pages for a team, person or ticket. */
export function ContextNotes({ subject }: { subject: Subject }) {
  const notes = useQuery({
    queryKey: queryKeys.notes(subject.type, subject.id),
    queryFn: ({ signal }) => run(listNotes(subject), signal),
  });
  const [editing, setEditing] = useState<{ open: boolean; note?: ContextNote }>({ open: false });
  const [importing, setImporting] = useState(false);
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium">Context notes</h3>
        <div className="ml-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setImporting(true)}>
            <FileDown /> Import from Confluence
          </Button>
          <Button variant="outline" size="sm" onClick={() => setEditing({ open: true })}>
            <Plus /> Note
          </Button>
        </div>
      </div>
      {notes.data?.length === 0 && <p className="text-sm text-muted-foreground">No notes yet.</p>}
      {(notes.data ?? []).map((n) => (
        <NoteCard
          key={n.id}
          note={n}
          subject={subject}
          onEdit={() => setEditing({ open: true, note: n })}
        />
      ))}
      <NoteDialog
        subject={subject}
        note={editing.note}
        open={editing.open}
        onOpenChange={(open) => setEditing((e) => ({ ...e, open }))}
      />
      <ConfluenceImportDialog subject={subject} open={importing} onOpenChange={setImporting} />
    </section>
  );
}

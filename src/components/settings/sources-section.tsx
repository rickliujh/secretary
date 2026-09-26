import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery } from "@tanstack/react-query";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readDir } from "@tauri-apps/plugin-fs";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Effect } from "effect";
import { FolderOpen, FolderPlus, NotebookText, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { useErrorToast, useSettings, useUpdateSettings } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { indexSources } from "@/app/sources";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { newId } from "@/lib/ids";
import { relativeTime } from "@/lib/time";
import type { DataSource } from "@/services/settings";
import { type IndexResult, type SourceStatus, Sources } from "@/services/sources";

/** Trailing separators dropped, so "/notes/" and "/notes" are the same folder. */
const normalizePath = (p: string) => (p.length > 1 ? p.replace(/[\\/]+$/, "") : p);

const folderName = (p: string) => normalizePath(p).split(/[\\/]/).filter(Boolean).pop() ?? p;

/**
 * Whether the folder holds an `.obsidian` folder; null when it cannot be told.
 * Listing the folder works where `exists` on a dot path would not: the picked
 * folder's scope does not match names starting with a dot on macOS and Linux.
 */
async function looksLikeVault(path: string): Promise<boolean | null> {
  try {
    const entries = await readDir(path);
    return entries.some((e) => e.name === ".obsidian" && e.isDirectory);
  } catch {
    return null;
  }
}

function indexSummary(results: IndexResult[]): string {
  const n = results.reduce((a, r) => a + r.added + r.updated + r.unchanged, 0);
  const skipped = results.reduce((a, r) => a + r.skipped, 0);
  const notes = `${n} ${n === 1 ? "note" : "notes"}`;
  return skipped
    ? `${notes} indexed, ${skipped} skipped (too large or unreadable).`
    : `${notes} indexed.`;
}

function useSourceStatus() {
  return useQuery({
    queryKey: queryKeys.sources,
    queryFn: ({ signal }) =>
      run(
        Effect.flatMap(Sources, (s) => s.status),
        signal,
      ),
  });
}

/** Index runs started from this page; results toast, failures map to the error toast. */
function useIndex() {
  const onError = useErrorToast();
  const mutation = useMutation({
    mutationFn: (opts: { sourceId?: string; force?: boolean; name?: string }) =>
      indexSources({ sourceId: opts.sourceId, force: opts.force }),
    onSuccess: (results, opts) =>
      opts.name && toast.success(`${opts.name}: ${indexSummary(results)}`),
    onError: (e, opts) => onError(e, () => mutation.mutate(opts)),
  });
  return mutation;
}

export function SourcesSection() {
  const onError = useErrorToast();
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const status = useSourceStatus();
  const index = useIndex();
  const sources = settings?.dataSources ?? [];

  const add = useMutation({
    mutationFn: async () => {
      // recursive: the pick grants read access to everything under the folder.
      const picked = await openDialog({ directory: true, recursive: true, multiple: false });
      return picked ? normalizePath(picked) : null;
    },
    onSuccess: (path) => {
      if (!path) return;
      if (sources.some((s) => normalizePath(s.path) === path)) {
        toast.info("That folder is already added.");
        return;
      }
      const source: DataSource = {
        id: newId(),
        kind: "obsidian",
        name: folderName(path),
        path,
        enabled: true,
        exclude: [],
      };
      update.mutate((s) => ({ ...s, dataSources: [...s.dataSources, source] }), {
        onSuccess: () => index.mutate({ sourceId: source.id, name: source.name }),
      });
    },
    onError: (e) => onError(e),
  });

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Data sources</CardTitle>
          <CardDescription>
            When you ask in Chat, the secretary can search your Obsidian notes. Notes are read and
            indexed on this machine; only the parts the chat looks at are sent to your model
            provider.
          </CardDescription>
          <CardAction>
            <Button
              variant="outline"
              disabled={add.isPending || update.isPending || !settings}
              onClick={() => add.mutate()}
            >
              <FolderPlus /> Add Obsidian vault...
            </Button>
          </CardAction>
        </CardHeader>
        {sources.length === 0 && (
          <CardContent>
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <NotebookText />
                </EmptyMedia>
                <EmptyTitle>No vaults yet</EmptyTitle>
                <EmptyDescription>
                  Pick your vault folder. Obsidian does not need to be running; its Markdown files
                  are read directly.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </CardContent>
        )}
      </Card>
      {sources.map((source) => (
        <SourceCard
          key={source.id}
          source={source}
          status={status.data?.find((s) => s.sourceId === source.id)}
          indexing={index.isPending && index.variables?.sourceId === source.id}
          onReindex={() => index.mutate({ sourceId: source.id, force: true, name: source.name })}
        />
      ))}
    </div>
  );
}

const SourceForm = z.object({
  name: z.string().trim().min(1, "Give it a name"),
  exclude: z.string().transform((text) =>
    text
      .split("\n")
      .map((line) =>
        line
          .trim()
          .replaceAll("\\", "/")
          .replace(/^\/+|\/+$/g, ""),
      )
      .filter(Boolean),
  ),
});
type SourceFormInput = z.input<typeof SourceForm>;

function SourceCard({
  source,
  status,
  indexing,
  onReindex,
}: {
  source: DataSource;
  status: SourceStatus | undefined;
  indexing: boolean;
  onReindex: () => void;
}) {
  const onError = useErrorToast();
  const update = useUpdateSettings();
  const vault = useQuery({
    queryKey: [...queryKeys.sources, "vault", source.path],
    queryFn: () => looksLikeVault(source.path),
  });

  const saveSource = (f: (s: DataSource) => DataSource, onSuccess?: () => void) =>
    update.mutate(
      (s) => ({
        ...s,
        dataSources: s.dataSources.map((d) => (d.id === source.id ? f(d) : d)),
      }),
      { onSuccess },
    );

  const form = useForm<SourceFormInput, unknown, z.output<typeof SourceForm>>({
    resolver: zodResolver(SourceForm),
    defaultValues: { name: source.name, exclude: source.exclude.join("\n") },
  });
  const excludeText = source.exclude.join("\n");
  useEffect(() => {
    form.reset({ name: source.name, exclude: excludeText });
  }, [source.name, excludeText, form]);
  const onSubmit = form.handleSubmit((v) =>
    saveSource(
      (d) => ({ ...d, name: v.name, exclude: v.exclude }),
      () => toast.success("Saved"),
    ),
  );

  const remove = () =>
    update.mutate((s) => ({ ...s, dataSources: s.dataSources.filter((d) => d.id !== source.id) }), {
      onSuccess: () => {
        toast.success(`Removed ${source.name}`);
        // Drops its rows from the index.
        void indexSources().catch((e) => onError(e));
      },
    });

  const { errors } = form.formState;
  const idPrefix = `source-${source.id}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {source.name}
          <Badge variant="outline">Obsidian</Badge>
          {!source.enabled && <Badge variant="secondary">Off</Badge>}
        </CardTitle>
        <CardDescription className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-xs">{source.path}</span>
        </CardDescription>
        <CardAction className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => revealItemInDir(source.path).catch((e) => onError(e))}
          >
            <FolderOpen /> Show
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={indexing || !source.enabled}
            onClick={onReindex}
          >
            <RefreshCw className={indexing ? "animate-spin" : undefined} />
            {indexing ? "Indexing..." : "Re-index"}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="sm" className="text-destructive">
                Remove
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove {source.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  The chat stops searching it and its index is deleted from this machine. Your notes
                  in the folder are not touched.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={remove}>Remove</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          {status
            ? `${status.documents} ${status.documents === 1 ? "note" : "notes"}${
                status.lastIndexedAt ? `, indexed ${relativeTime(status.lastIndexedAt)}` : ""
              }`
            : "Not indexed yet"}
        </p>
        {vault.data === false && (
          <Alert>
            <TriangleAlert />
            <AlertTitle>This folder doesn't look like an Obsidian vault</AlertTitle>
            <AlertDescription>
              It has no .obsidian folder. Its Markdown files are indexed anyway.
            </AlertDescription>
          </Alert>
        )}
        {status?.lastError && (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>The last index run failed</AlertTitle>
            <AlertDescription>{status.lastError}</AlertDescription>
          </Alert>
        )}

        <Field orientation="horizontal">
          <Switch
            id={`${idPrefix}-enabled`}
            checked={source.enabled}
            disabled={update.isPending}
            onCheckedChange={(on) => saveSource((d) => ({ ...d, enabled: on }))}
          />
          <FieldLabel htmlFor={`${idPrefix}-enabled`}>Search this vault from Chat</FieldLabel>
        </Field>

        <form onSubmit={onSubmit} className="flex flex-col gap-4 border-t pt-4">
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor={`${idPrefix}-name`}>Name</FieldLabel>
              <Input id={`${idPrefix}-name`} className="max-w-xs" {...form.register("name")} />
              <FieldError errors={[errors.name]} />
            </Field>
            <Field data-invalid={!!errors.exclude}>
              <FieldLabel htmlFor={`${idPrefix}-exclude`}>Excluded folders</FieldLabel>
              <Textarea
                id={`${idPrefix}-exclude`}
                rows={3}
                placeholder={"Private\nJournal/2024"}
                className="font-mono text-xs"
                {...form.register("exclude")}
              />
              <FieldDescription>
                One folder or file per line, relative to the vault. Folders starting with a dot
                (.obsidian, .trash) are always left out.
              </FieldDescription>
              <FieldError errors={[errors.exclude]} />
            </Field>
          </FieldGroup>
          <div>
            <Button
              type="submit"
              variant="outline"
              disabled={update.isPending || !form.formState.isDirty}
            >
              Save
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

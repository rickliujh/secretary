import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Effect } from "effect";
import {
  ChevronDown,
  CircleCheck,
  NotebookText,
  PlugZap,
  Plus,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { describeError } from "@/app/errors";
import { useSettings, useUpdateSettings } from "@/app/hooks";
import { isMac } from "@/app/platform";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { newId } from "@/lib/ids";
import type { DataSource } from "@/services/settings";
import { type SourceCheck, Sources } from "@/services/sources";

const isWindows = typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent);

/** Where Obsidian installs the `obsidian` command on this OS (what "automatic" finds first). */
const DEFAULT_CLI_PATH = isMac
  ? "/usr/local/bin/obsidian"
  : isWindows
    ? "%LOCALAPPDATA%\\Programs\\Obsidian\\Obsidian.com"
    : "~/.local/bin/obsidian";

const sameVault = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export function SourcesSection() {
  const { data: settings } = useSettings();
  const sources = settings?.dataSources ?? [];

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle>Data sources</CardTitle>
          <CardDescription>
            When you ask in Chat, the secretary can search your Obsidian vaults through Obsidian's
            command line interface. Obsidian opens when needed. Only the notes the chat reads are
            sent to your model provider.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Needs Obsidian 1.12.7 or later with Settings &gt; General &gt; Advanced &gt; Command
            line interface turned on. On macOS, Obsidian asks for your password to install the{" "}
            <code className="font-mono text-xs">obsidian</code> command.
          </p>
          {settings && <AddVault sources={sources} />}
          {settings && <Advanced cliPath={settings.obsidian.cliPath} />}
        </CardContent>
      </Card>
      {settings && sources.length === 0 && (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <NotebookText />
            </EmptyMedia>
            <EmptyTitle>No vaults yet</EmptyTitle>
            <EmptyDescription>Add a vault above to let the chat search its notes.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {sources.map((source) => (
        <SourceCard key={source.id} source={source} />
      ))}
    </div>
  );
}

const AddForm = z.object({ vault: z.string().trim().min(1, "Pick or type a vault name") });
type AddFormValues = z.infer<typeof AddForm>;

/**
 * Lists the vaults Obsidian knows once the user starts adding, since asking
 * opens Obsidian. A name can always be typed in instead.
 */
function AddVault({ sources }: { sources: DataSource[] }) {
  const update = useUpdateSettings();
  const [open, setOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  const vaults = useQuery({
    queryKey: [...queryKeys.sources, "vaults"],
    queryFn: ({ signal }) =>
      run(
        Effect.flatMap(Sources, (s) => s.vaults),
        signal,
      ),
    enabled: open,
    retry: false,
    staleTime: 0,
  });
  const choices = (vaults.data ?? []).filter((v) => !sources.some((s) => sameVault(s.vault, v)));
  const manual = typing || vaults.isError || (vaults.isSuccess && choices.length === 0);

  const form = useForm<AddFormValues>({
    resolver: zodResolver(
      AddForm.refine((v) => !sources.some((s) => sameVault(s.vault, v.vault)), {
        message: "That vault is already added",
        path: ["vault"],
      }),
    ),
    defaultValues: { vault: "" },
  });

  const close = () => {
    setOpen(false);
    setTyping(false);
    form.reset({ vault: "" });
  };

  const onSubmit = form.handleSubmit(({ vault }) => {
    const source: DataSource = { id: newId(), kind: "obsidian", name: vault, vault, enabled: true };
    update.mutate((s) => ({ ...s, dataSources: [...s.dataSources, source] }), {
      onSuccess: () => {
        toast.success(`Added ${vault}`);
        close();
      },
    });
  });

  if (!open) {
    return (
      <div>
        <Button variant="outline" onClick={() => setOpen(true)}>
          <Plus /> Add vault...
        </Button>
      </div>
    );
  }

  const failure = vaults.isError ? describeError(vaults.error) : null;
  const { errors } = form.formState;

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 rounded-md border p-4">
      {failure && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>{failure.title}</AlertTitle>
          <AlertDescription>
            <p>{failure.description ?? "Obsidian did not list its vaults."}</p>
            <p>You can still type the vault name.</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              disabled={vaults.isFetching}
              onClick={() => vaults.refetch()}
            >
              <RefreshCw className={vaults.isFetching ? "animate-spin" : undefined} /> Retry
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <Field data-invalid={!!errors.vault}>
        <FieldLabel htmlFor="add-vault">Vault</FieldLabel>
        {manual ? (
          <Input
            id="add-vault"
            className="max-w-xs"
            placeholder="Vault name as Obsidian shows it"
            autoFocus
            {...form.register("vault")}
          />
        ) : (
          <Controller
            control={form.control}
            name="vault"
            render={({ field }) => (
              <Select
                value={field.value}
                onValueChange={field.onChange}
                disabled={vaults.isPending}
              >
                <SelectTrigger id="add-vault" className="w-64">
                  <SelectValue
                    placeholder={vaults.isPending ? "Asking Obsidian..." : "Pick a vault"}
                  />
                </SelectTrigger>
                <SelectContent>
                  {choices.map((v) => (
                    <SelectItem key={v} value={v}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        )}
        {vaults.isSuccess && choices.length === 0 && (
          <FieldDescription>
            {vaults.data.length === 0
              ? "Obsidian listed no vaults. Type the vault name."
              : "Every vault Obsidian lists is already added."}
          </FieldDescription>
        )}
        <FieldError errors={[errors.vault]} />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={update.isPending}>
          Add
        </Button>
        <Button type="button" variant="ghost" onClick={close}>
          Cancel
        </Button>
        {!manual && (
          <Button type="button" variant="link" onClick={() => setTyping(true)}>
            Type a name instead
          </Button>
        )}
      </div>
    </form>
  );
}

const CliPathForm = z.object({
  cliPath: z
    .string()
    .trim()
    .refine((p) => p === "" || /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p), {
      message: "Use the full path, or leave it empty",
    }),
});
type CliPathValues = z.infer<typeof CliPathForm>;

function Advanced({ cliPath }: { cliPath: string }) {
  const client = useQueryClient();
  const update = useUpdateSettings();
  const form = useForm<CliPathValues>({
    resolver: zodResolver(CliPathForm),
    defaultValues: { cliPath },
  });
  useEffect(() => {
    form.reset({ cliPath });
  }, [cliPath, form]);

  const onSubmit = form.handleSubmit((v) =>
    update.mutate((s) => ({ ...s, obsidian: { ...s.obsidian, cliPath: v.cliPath } }), {
      onSuccess: () => {
        toast.success("Saved");
        void client.invalidateQueries({ queryKey: queryKeys.sources });
      },
    }),
  );
  const { errors } = form.formState;

  return (
    <Collapsible defaultOpen={cliPath !== ""} className="border-t pt-4">
      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="group -ml-2">
          <ChevronDown className="transition-transform group-data-[state=closed]:-rotate-90" />
          Advanced
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-3 pt-2">
          <Field data-invalid={!!errors.cliPath}>
            <FieldLabel htmlFor="obsidian-cli-path">Obsidian command</FieldLabel>
            <Input
              id="obsidian-cli-path"
              className="max-w-md font-mono text-xs"
              placeholder={DEFAULT_CLI_PATH}
              spellCheck={false}
              {...form.register("cliPath")}
            />
            <FieldDescription>
              Full path of the <code className="font-mono">obsidian</code> command. Leave empty to
              find it where Obsidian installs it.
            </FieldDescription>
            <FieldError errors={[errors.cliPath]} />
          </Field>
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
      </CollapsibleContent>
    </Collapsible>
  );
}

const SourceForm = z.object({ name: z.string().trim().min(1, "Give it a name") });
type SourceFormValues = z.infer<typeof SourceForm>;

function SourceCard({ source }: { source: DataSource }) {
  const update = useUpdateSettings();
  const test = useMutation({
    mutationFn: (): Promise<SourceCheck> => run(Effect.flatMap(Sources, (s) => s.check(source.id))),
  });

  const saveSource = (f: (s: DataSource) => DataSource, onSuccess?: () => void) =>
    update.mutate(
      (s) => ({
        ...s,
        dataSources: s.dataSources.map((d) => (d.id === source.id ? f(d) : d)),
      }),
      { onSuccess },
    );

  const form = useForm<SourceFormValues>({
    resolver: zodResolver(SourceForm),
    defaultValues: { name: source.name },
  });
  useEffect(() => {
    form.reset({ name: source.name });
  }, [source.name, form]);
  const onSubmit = form.handleSubmit((v) =>
    saveSource(
      (d) => ({ ...d, name: v.name }),
      () => toast.success("Saved"),
    ),
  );

  const remove = () =>
    update.mutate((s) => ({ ...s, dataSources: s.dataSources.filter((d) => d.id !== source.id) }), {
      onSuccess: () => toast.success(`Removed ${source.name}`),
    });

  const { errors } = form.formState;
  const idPrefix = `source-${source.id}`;
  const result = test.data;
  const testFailure = test.isError ? describeError(test.error) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {source.name}
          <Badge variant="outline">Obsidian</Badge>
          {!source.enabled && <Badge variant="secondary">Off</Badge>}
        </CardTitle>
        <CardDescription>
          Vault <span className="font-medium text-foreground">{source.vault}</span>
        </CardDescription>
        <CardAction className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={test.isPending}
            onClick={() => test.mutate()}
          >
            <PlugZap /> {test.isPending ? "Testing..." : "Test"}
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
                  The chat stops searching this vault. Your notes in Obsidian are not touched.
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
        {result?.ok === true && (
          <Alert>
            <CircleCheck />
            <AlertTitle>
              Connected: {result.notes} {result.notes === 1 ? "file" : "files"}
            </AlertTitle>
          </Alert>
        )}
        {result?.ok === false && (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>
              {result.kind === "not_found" ? "Vault not found" : "Obsidian isn't reachable"}
            </AlertTitle>
            <AlertDescription>{result.message}</AlertDescription>
          </Alert>
        )}
        {testFailure && (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>{testFailure.title}</AlertTitle>
            {testFailure.description && (
              <AlertDescription>{testFailure.description}</AlertDescription>
            )}
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

        <form onSubmit={onSubmit} className="flex flex-col gap-3 border-t pt-4">
          <Field data-invalid={!!errors.name}>
            <FieldLabel htmlFor={`${idPrefix}-name`}>Name</FieldLabel>
            <Input id={`${idPrefix}-name`} className="max-w-xs" {...form.register("name")} />
            <FieldDescription>
              Shown here and to the model when the chat cites a note.
            </FieldDescription>
            <FieldError errors={[errors.name]} />
          </Field>
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

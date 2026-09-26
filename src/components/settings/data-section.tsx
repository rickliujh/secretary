import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { appDataDir, appLogDir, join } from "@tauri-apps/api/path";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Effect } from "effect";
import { Download, Eraser, FolderOpen, Sparkles, Upload } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { runCleanup } from "@/app/cleanup";
import { useErrorToast } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { relativeTime } from "@/lib/time";
import { pruneImportBackups } from "@/services/data/backups";
import {
  type CleanupResult,
  databaseSize,
  lastCleanup,
  RETENTION,
} from "@/services/data/retention";
import {
  type ExportFile,
  exportAll,
  importAll,
  parseExport,
  resetCache,
} from "@/services/data/transfer";
import { Db } from "@/services/db";
import { SETTINGS_FILE } from "@/services/settings/live";

async function dataPaths(database: string) {
  return [
    { label: "Database", path: database },
    { label: "Settings file", path: await join(await appDataDir(), SETTINGS_FILE) },
    { label: "Logs", path: await appLogDir() },
  ];
}

const stamp = () => new Date().toISOString().slice(0, 19).replaceAll(":", "-");

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function cleanupSummary(r: CleanupResult) {
  const parts = [
    r.llmCalls && `${r.llmCalls} old usage records`,
    r.staleIssues && `${r.staleIssues} tickets no longer synced`,
    r.snapshots && `${r.snapshots} old inbox snapshots`,
  ].filter(Boolean);
  return parts.length ? `Removed ${parts.join(", ")}.` : "Nothing needed removing.";
}

const rowCount = (f: ExportFile) => Object.values(f.tables).reduce((n, rows) => n + rows.length, 0);

export function DataSection() {
  const onError = useErrorToast();
  const client = useQueryClient();
  const paths = useQuery({
    queryKey: queryKeys.dataPaths,
    queryFn: async () => dataPaths((await run(Effect.map(Db, (db) => db.location))) ?? ""),
  });
  const storage = useQuery({
    queryKey: queryKeys.storage,
    queryFn: () => run(Effect.all({ size: databaseSize, last: lastCleanup })),
  });
  const cleanMutation = useMutation({
    mutationFn: () => runCleanup(true),
    onSuccess: (r) => r && toast.success(cleanupSummary(r)),
    onError: (e) => onError(e),
  });
  const [pending, setPending] = useState<ExportFile | null>(null);
  const [resetting, setResetting] = useState(false);

  const exportMutation = useMutation({
    mutationFn: async () => {
      const path = await saveDialog({
        defaultPath: `secretary-export-${stamp()}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return null;
      const data = await run(exportAll);
      await writeTextFile(path, JSON.stringify(data, null, 2));
      return data;
    },
    onSuccess: (d) =>
      d && toast.success(`Exported ${rowCount(d)} records. Keys and tokens are not included.`),
    onError: (e) => onError(e),
  });

  // Reading and checking the file changes nothing; the import itself waits for confirmation.
  const pick = useMutation({
    mutationFn: async () => {
      const path = await openDialog({
        multiple: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return null;
      return run(parseExport(await readTextFile(path)));
    },
    onSuccess: (f) => f && setPending(f),
    onError: (e) => onError(e),
  });

  const importMutation = useMutation({
    mutationFn: async (file: ExportFile) => {
      // A backup of the current data first, so an import can be undone by importing it.
      const backup = await join(await appDataDir(), `backup-before-import-${stamp()}.json`);
      await writeTextFile(backup, JSON.stringify(await run(exportAll)));
      await run(importAll(file));
      await pruneImportBackups().catch(() => 0);
      return backup;
    },
    onSuccess: (backup) => {
      void client.invalidateQueries();
      toast.success("Imported. Add API keys and tokens again in Settings.", {
        description: `Your previous data was saved to ${backup}`,
        duration: 10_000,
      });
    },
    onError: (e) => onError(e),
    onSettled: () => setPending(null),
  });

  const resetMutation = useMutation({
    mutationFn: () => run(resetCache),
    onSuccess: () => {
      void client.invalidateQueries();
      toast.success("Jira cache cleared. The next sync fetches everything again.");
    },
    onError: (e) => onError(e),
    onSettled: () => setResetting(false),
  });

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Local data</CardTitle>
          <CardDescription>
            Everything stays on this machine. Tokens and keys live in the OS keychain and are never
            written to these files or to exports.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {(paths.data ?? []).map((p) => (
            <div key={p.label} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{p.label}</p>
                <p className="truncate font-mono text-xs text-muted-foreground">{p.path}</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => revealItemInDir(p.path).catch((e) => onError(e))}
              >
                <FolderOpen /> Show
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Storage</CardTitle>
          <CardDescription>
            Cleanup runs daily. It removes model usage records after {RETENTION.llmCallsDays} days,
            tickets that left your sync scope after {RETENTION.staleIssueDays} days, and the ticket
            context saved with inbox items after {RETENTION.snapshotDays} days. Logs keep at most
            three files of 2 MB and import backups the newest three. Your threads, notes, memories,
            chats and drafts are never removed.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm">
            <p>
              Database{" "}
              <span className="font-medium">
                {storage.data ? mb(storage.data.size.bytes) : "..."}
              </span>
              {storage.data && storage.data.size.freeBytes > 0 && (
                <span className="text-muted-foreground">
                  {" "}
                  ({mb(storage.data.size.freeBytes)} reusable)
                </span>
              )}
            </p>
            <p className="text-muted-foreground">
              {storage.data?.last
                ? `Last cleanup ${relativeTime(storage.data.last.at)}. ${cleanupSummary(storage.data.last)}`
                : "Not cleaned up yet."}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={cleanMutation.isPending}
            onClick={() => cleanMutation.mutate()}
          >
            <Sparkles /> Clean up now
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Export, import and reset</CardTitle>
          <CardDescription>
            An export holds your contacts, teams, notes, dependencies, drafts, memories, inbox
            threads and settings. The Jira cache is left out; sync rebuilds it.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={exportMutation.isPending}
            onClick={() => exportMutation.mutate()}
          >
            <Download /> Export everything...
          </Button>
          <Button
            variant="outline"
            disabled={pick.isPending || importMutation.isPending}
            onClick={() => pick.mutate()}
          >
            <Upload /> Import from export...
          </Button>
          <Button
            variant="outline"
            disabled={resetMutation.isPending}
            onClick={() => setResetting(true)}
          >
            <Eraser /> Clear Jira cache
          </Button>
        </CardContent>
      </Card>

      <AlertDialog open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace your data with this export?</AlertDialogTitle>
            <AlertDialogDescription>
              The export from {pending?.exportedAt.slice(0, 10)} has{" "}
              {pending ? rowCount(pending) : 0} records. Your current contacts, notes, dependencies,
              drafts, memories and threads are replaced, and settings too. A backup of what you have
              now is saved first. Keys and tokens are not part of exports; add them again
              afterwards.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => pending && importMutation.mutate(pending)}>
              Replace and import
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={resetting} onOpenChange={setResetting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear the Jira cache?</AlertDialogTitle>
            <AlertDialogDescription>
              Tickets and comments are removed from this machine and the next sync fetches them
              again. Your own data (pins, notes, dependencies, threads) stays.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => resetMutation.mutate()}>
              Clear cache
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

import { useQuery } from "@tanstack/react-query";
import { appDataDir, appLogDir, join } from "@tauri-apps/api/path";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Effect } from "effect";
import { FolderOpen } from "lucide-react";
import { useErrorToast } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Db } from "@/services/db";
import { SETTINGS_FILE } from "@/services/settings/live";

async function dataPaths(database: string) {
  return [
    { label: "Database", path: database },
    { label: "Settings file", path: await join(await appDataDir(), SETTINGS_FILE) },
    { label: "Logs", path: await appLogDir() },
  ];
}

export function DataSection() {
  const onError = useErrorToast();
  const paths = useQuery({
    queryKey: queryKeys.dataPaths,
    queryFn: async () => dataPaths((await run(Effect.map(Db, (db) => db.location))) ?? ""),
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Local data</CardTitle>
        <CardDescription>
          Everything stays on this machine. Tokens and keys live in the OS keychain and are never
          written to these files. Export, import and cache reset arrive with hardening (phase 8).
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
  );
}

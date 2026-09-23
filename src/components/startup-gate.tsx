import { useQuery } from "@tanstack/react-query";
import { Effect } from "effect";
import { AlertCircle, Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { describeError } from "@/app/errors";
import { run } from "@/app/runtime";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Db } from "@/services/db";
import { Settings } from "@/services/settings";

/** Opens the database (running migrations) and loads settings before the UI. */
export function StartupGate({ children }: { children: ReactNode }) {
  const startup = useQuery({
    queryKey: ["startup"],
    queryFn: () => run(Effect.all([Db, Effect.flatMap(Settings, (s) => s.get)])),
    staleTime: Number.POSITIVE_INFINITY,
  });
  if (startup.isPending) {
    return (
      <div className="flex h-svh items-center justify-center text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }
  if (startup.isError) {
    const d = describeError(startup.error);
    return (
      <div className="flex h-svh items-center justify-center p-8">
        <Alert variant="destructive" className="max-w-lg">
          <AlertCircle />
          <AlertTitle>{d.title}</AlertTitle>
          <AlertDescription>
            <p>{d.description}</p>
            <Button className="mt-3" variant="outline" size="sm" onClick={() => startup.refetch()}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }
  return children;
}

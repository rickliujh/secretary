import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { Button } from "@/components/ui/button";
import { timing } from "@/services/dependencies/logic";
import { listDependencies } from "@/services/dependencies/queries";
import { localDate } from "@/services/intake";
import { DependencyDialog } from "./dependency-dialog";
import { DependencyRowView } from "./dependency-row";

/** Dependencies of one ticket, on the ticket detail (FR-1.6, FR-3.2). */
export function IssueDependencies({ issueKey }: { issueKey: string }) {
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const list = useQuery({
    queryKey: queryKeys.dependencyList(true, issueKey),
    queryFn: ({ signal }) => run(listDependencies({ includeResolved: true, issueKey }), signal),
  });
  const today = localDate();
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center">
        <h3 className="text-sm font-medium">Waiting on</h3>
        <Button className="ml-auto" size="sm" variant="outline" onClick={() => setAdding(true)}>
          <Plus /> Add dependency
        </Button>
      </div>
      {list.data?.length === 0 && (
        <p className="text-sm text-muted-foreground">This ticket is not waiting on anything.</p>
      )}
      <ul className="flex flex-col divide-y rounded-lg border empty:hidden">
        {(list.data ?? []).map((d) => (
          <li key={d.id}>
            <DependencyRowView
              dep={d}
              timing={timing(d, today)}
              showIssue={false}
              onOpen={() => navigate({ to: "/waiting", search: { id: d.id } })}
            />
          </li>
        ))}
      </ul>
      <DependencyDialog issueKey={issueKey} open={adding} onOpenChange={setAdding} />
    </section>
  );
}

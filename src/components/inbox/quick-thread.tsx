import { useNavigate } from "@tanstack/react-router";
import { useActiveRuns } from "@/app/intake-runs";
import { Composer, toTriageInput } from "./composer";
import { useTriage } from "./use-inbox";

/** Today's capture box: starts a thread and opens it as soon as it is stored (D22, D49, D68). */
export function QuickThread() {
  const navigate = useNavigate();
  const triage = useTriage((id) => navigate({ to: "/inbox", search: { item: id } }));
  const busy = useActiveRuns().length > 0;
  return (
    <Composer
      compact
      withSender
      lane="new"
      busy={busy}
      onSend={(m) => triage.mutate(toTriageInput(m))}
    />
  );
}

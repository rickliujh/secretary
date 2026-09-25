import { useNavigate } from "@tanstack/react-router";
import { Composer, toTriageInput } from "./composer";
import { useTriage } from "./use-inbox";

/** Dashboard entry point: starts a thread and opens it (D22). */
export function QuickThread() {
  const navigate = useNavigate();
  const triage = useTriage((id) => navigate({ to: "/inbox", search: { item: id } }));
  return (
    <Composer
      compact
      withSender
      busy={triage.isPending}
      progress={triage.progress}
      onCancel={triage.cancel}
      onSend={(m) => triage.mutate(toTriageInput(m))}
    />
  );
}

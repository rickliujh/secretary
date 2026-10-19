/**
 * "End of day" on Today (FR-19.9, D63): runs the end-of-day pass now and opens
 * the day's page in the Inbox. Code writes it; no model is asked.
 */
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Loader2, Sunset } from "lucide-react";
import { useErrorToast, useSettings } from "@/app/hooks";
import { runDayEndNow } from "@/app/work";
import { Button } from "@/components/ui/button";

export function DayEndButton() {
  const { data: settings } = useSettings();
  const navigate = useNavigate();
  const onError = useErrorToast();
  const pass = useMutation({
    mutationFn: () => runDayEndNow("button"),
    onSuccess: (r) => {
      if (r.skipped === "disabled") return;
      void navigate({ to: "/inbox", search: { item: r.id } });
    },
    onError: (e) => onError(e, () => pass.mutate()),
  });
  if (!settings?.work.enabled) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pass.isPending}
      onClick={() => pass.mutate()}
      title="What changed today, what is due tomorrow, and the questions left over"
    >
      {pass.isPending ? <Loader2 className="animate-spin" /> : <Sunset />}
      End of day
    </Button>
  );
}

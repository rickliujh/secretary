import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ListTodo, X } from "lucide-react";
import { useUpdateSettings } from "@/app/hooks";
import { run } from "@/app/runtime";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { smallAskHome } from "@/services/small-asks/queries";
import { SMALL_ASK_KEYS } from "./small-ask-keys";

/** Points to the small-asks setting once, while no home is set (FR-10.5). */
export function SmallAsksHint() {
  const client = useQueryClient();
  const update = useUpdateSettings();
  const home = useQuery({
    queryKey: SMALL_ASK_KEYS.home,
    queryFn: ({ signal }) => run(smallAskHome, signal),
  });
  if (!home.data || home.data.home || home.data.hintDismissed) return null;
  const dismiss = () =>
    update.mutate((s) => ({ ...s, smallAsks: { ...s.smallAsks, hintDismissed: true } }), {
      onSuccess: () => void client.invalidateQueries({ queryKey: SMALL_ASK_KEYS.home }),
    });
  return (
    <Alert>
      <ListTodo />
      <AlertTitle>Track small asks as tickets</AlertTitle>
      <AlertDescription>
        <p>
          Pick a project for the small things people ask of you, and the secretary will offer each
          one as a ticket you track with one click.{" "}
          <Link to="/settings" search={{ tab: "jira" }} className="underline" onClick={dismiss}>
            Set it up in Settings
          </Link>
          .
        </p>
      </AlertDescription>
      <AlertAction>
        <Button
          size="icon"
          variant="ghost"
          className="size-6"
          aria-label="Do not show this again"
          disabled={update.isPending}
          onClick={dismiss}
        >
          <X />
        </Button>
      </AlertAction>
    </Alert>
  );
}

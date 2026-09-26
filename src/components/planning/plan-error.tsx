import { Link } from "@tanstack/react-router";
import { AlertCircle } from "lucide-react";
import { describeError, errorIssues } from "@/app/errors";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/** A failed draft or proposal, shown where it happened (with the model's issues, if any). */
export function PlanError({ error }: { error: unknown }) {
  const d = describeError(error);
  const issues = errorIssues(error);
  return (
    <Alert variant="destructive">
      <AlertCircle />
      <AlertTitle>{d.title}</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-1">
        {d.description && <span>{d.description}</span>}
        {issues.length > 0 && (
          <ul className="list-disc pl-4 text-xs">
            {issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        )}
        {d.settingsTab && (
          <Link to="/settings" search={{ tab: d.settingsTab }} className="underline">
            Open settings
          </Link>
        )}
      </AlertDescription>
    </Alert>
  );
}

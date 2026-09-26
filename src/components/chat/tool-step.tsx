import { Link } from "@tanstack/react-router";
import type { ToolUIPart } from "ai";
import {
  AlertCircle,
  BookOpen,
  Hourglass,
  Loader2,
  NotebookText,
  Search,
  Sparkles,
  Target,
  Ticket,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import type { ChatTools } from "@/services/chat/tools";

type Part = ToolUIPart<{
  [K in keyof ChatTools]: {
    input: Parameters<NonNullable<ChatTools[K]["execute"]>>[0];
    output: unknown;
  };
}>;

const describe = (part: Part): [ReactNode, string] => {
  const input = (part.input ?? {}) as Record<string, string | undefined>;
  switch (part.type) {
    case "tool-search_tickets":
      return [<Search key="i" />, `Searched tickets for “${input.text ?? ""}”`];
    case "tool-get_ticket":
      return [<Ticket key="i" />, `Read ${input.key ?? "a ticket"}`];
    case "tool-waiting_on":
      return [
        <Hourglass key="i" />,
        input.owner ? `Checked what you wait on from ${input.owner}` : "Checked what you wait on",
      ];
    case "tool-find_contacts":
      return [<Users key="i" />, `Looked up “${input.text ?? ""}” in people and teams`];
    case "tool-search_notes":
      return [<NotebookText key="i" />, `Searched notes for “${input.text ?? ""}”`];
    case "tool-my_focus":
      return [<Target key="i" />, "Read your focus list"];
    case "tool-search_confluence":
      return [<BookOpen key="i" />, `Searched Confluence for “${input.text ?? ""}”`];
    case "tool-propose_actions":
      return [<Sparkles key="i" />, "Prepared proposals"];
    default:
      return [<Search key="i" />, "Looked something up"];
  }
};

/** One tool call in the chat: what it looked at, and a link when it proposed changes. */
export function ToolStep({ part }: { part: Part }) {
  const [icon, label] = describe(part);
  const output =
    part.state === "output-available" ? (part.output as Record<string, unknown>) : null;
  const failed = part.state === "output-error" || (output && "error" in output);
  const proposal =
    part.type === "tool-propose_actions" && output && !failed
      ? (output as { threadId: string; proposed: string[]; questions: string[] })
      : null;
  return (
    <div className="flex flex-col gap-1 text-xs text-muted-foreground">
      <span className="flex items-center gap-1.5 [&_svg]:size-3.5">
        {part.state === "input-streaming" || part.state === "input-available" ? (
          <Loader2 className="animate-spin" />
        ) : failed ? (
          <AlertCircle className="text-destructive" />
        ) : (
          icon
        )}
        {label}
        {failed && (
          <span>
            : {String((output as { error?: string } | null)?.error ?? part.errorText ?? "failed")}
          </span>
        )}
      </span>
      {proposal && (
        <div className="ml-5 flex flex-col gap-1 rounded-md border bg-background p-2 text-sm text-foreground">
          {proposal.proposed.length > 0 ? (
            <ul className="list-disc pl-4">
              {proposal.proposed.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          ) : (
            <p className="text-muted-foreground">Nothing to propose yet.</p>
          )}
          {proposal.questions.map((q) => (
            <p key={q} className="text-amber-700 dark:text-amber-300">
              {q}
            </p>
          ))}
          <Link to="/inbox" search={{ item: proposal.threadId }} className="text-xs underline">
            Review and approve in the Inbox
          </Link>
        </div>
      )}
    </div>
  );
}

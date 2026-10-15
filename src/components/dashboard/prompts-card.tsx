import { Link, useNavigate } from "@tanstack/react-router";
import { useSettings } from "@/app/hooks";
import { askSearch } from "@/components/chat/ask";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** One-click questions for the chat, each in a new conversation (D42). */
export function PromptsCard() {
  const { data: settings } = useSettings();
  const navigate = useNavigate();
  const prompts = settings?.suggestedPrompts ?? [];

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Ask the secretary</CardTitle>
        <CardDescription>Starts a new chat with the question.</CardDescription>
        <CardAction>
          <Link to="/settings" search={{ tab: "general" }} className="text-sm underline">
            Edit
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent>
        {settings && prompts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No suggested prompts.{" "}
            <Link to="/settings" search={{ tab: "general" }} className="underline">
              Add some in Settings
            </Link>
            .
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {prompts.map((p) => (
              <Tooltip key={p.id}>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-auto min-h-8 justify-start py-1.5 text-left whitespace-normal"
                    onClick={() => void navigate({ to: "/chat", search: askSearch(p.message) })}
                  >
                    {p.title}
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  <span className="line-clamp-6">{p.message}</span>
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

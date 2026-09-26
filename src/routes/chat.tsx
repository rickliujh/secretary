import { useChat } from "@ai-sdk/react";
import { createFileRoute } from "@tanstack/react-router";
import { isToolUIPart } from "ai";
import { AlertCircle, CornerDownLeft, MessagesSquare, RotateCcw, Square } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useSettings } from "@/app/hooks";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { ToolStep } from "@/components/chat/tool-step";
import { SecretaryTransport } from "@/components/chat/transport";
import { Markdown } from "@/components/markdown";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { TIERS, type Tier } from "@/services/llm/tasks";

export const Route = createFileRoute("/chat")({ component: ChatPage });

const SUGGESTIONS = [
  "What should I focus on today?",
  "What am I waiting on, and what is overdue?",
  "Who should I ask about Kubernetes?",
];
const ROUTED = "routed";

/** Ask the secretary (FR-8, design.md D25). Changes go through the Inbox. */
function ChatPage() {
  const { data: settings } = useSettings();
  const [tier, setTier] = useState<string>(ROUTED);
  const tierRef = useRef<Tier | undefined>(undefined);
  tierRef.current = tier === ROUTED ? undefined : (tier as Tier);
  const transport = useMemo(() => new SecretaryTransport(() => tierRef.current), []);
  const { messages, sendMessage, status, stop, error, regenerate, setMessages } = useChat({
    transport,
  });
  const [input, setInput] = useState("");
  const busy = status === "submitted" || status === "streaming";

  const send = (text: string) => {
    if (!text.trim() || busy) return;
    void sendMessage({ text: text.trim() });
    setInput("");
  };

  return (
    <div className="mx-auto flex h-full min-h-0 max-w-3xl flex-col gap-3">
      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="gap-5 p-2">
          {messages.length === 0 && (
            <div className="flex flex-col items-center gap-3 pt-16 text-center">
              <MessagesSquare className="size-8 text-muted-foreground" />
              <h2 className="text-lg font-semibold">Ask the secretary</h2>
              <p className="max-w-md text-sm text-muted-foreground">
                Questions are answered from your synced tickets, dependencies, contacts and notes.
                Ask for a change and it prepares proposals in the Inbox for you to approve.
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <Button key={s} variant="outline" size="sm" onClick={() => send(s)}>
                    {s}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m) =>
            m.role === "user" ? (
              <div
                key={m.id}
                className="ml-auto max-w-[85%] rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap"
              >
                {m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")}
              </div>
            ) : (
              <div key={m.id} className="flex flex-col gap-2">
                {m.parts.map((p, i) =>
                  p.type === "text" ? (
                    // biome-ignore lint/suspicious/noArrayIndexKey: parts only append.
                    <Markdown key={i} className="text-sm">
                      {p.text}
                    </Markdown>
                  ) : isToolUIPart(p) ? (
                    <ToolStep
                      key={p.toolCallId}
                      part={p as Parameters<typeof ToolStep>[0]["part"]}
                    />
                  ) : null,
                )}
              </div>
            ),
          )}
          {status === "submitted" && <p className="text-sm text-muted-foreground">Thinking...</p>}
          {error && (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>No answer</AlertTitle>
              <AlertDescription className="flex flex-col items-start gap-2">
                <span>{error.message}</span>
                <Button size="sm" variant="outline" onClick={() => void regenerate()}>
                  <RotateCcw /> Try again
                </Button>
              </AlertDescription>
            </Alert>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="flex flex-col gap-2 rounded-lg border p-2">
        <Textarea
          aria-label="Ask the secretary"
          className="min-h-0 resize-none border-0 shadow-none focus-visible:ring-0"
          rows={2}
          placeholder="Ask about your tickets, dependencies or people, or ask for a change."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send(input);
            }
          }}
        />
        <div className="flex items-center gap-2">
          <Select value={tier} onValueChange={setTier}>
            <SelectTrigger size="sm" className="w-44" aria-label="Model tier">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ROUTED}>Chat's usual tier</SelectItem>
              {TIERS.filter((t) => settings?.tiers[t]).map((t) => (
                <SelectItem key={t} value={t}>
                  {t} ({settings?.tiers[t]?.model})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {messages.length > 0 && !busy && (
            <Button size="sm" variant="ghost" onClick={() => setMessages([])}>
              New chat
            </Button>
          )}
          <span className="ml-auto text-xs text-muted-foreground">
            Nothing changes until you approve it in the Inbox.
          </span>
          {busy ? (
            <Button size="sm" variant="outline" onClick={() => void stop()}>
              <Square /> Stop
            </Button>
          ) : (
            <Button size="sm" disabled={!input.trim()} onClick={() => send(input)}>
              <CornerDownLeft /> Send
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

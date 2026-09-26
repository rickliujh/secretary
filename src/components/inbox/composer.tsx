import { ClipboardPaste, CornerDownLeft, Loader2, Type, X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { usePeople } from "@/app/queries";
import { SOURCE_LABELS } from "@/components/labels";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { isSubmitEnter } from "@/lib/keys";
import { cn } from "@/lib/utils";
import { SOURCES, type Source } from "@/services/intake";
import { SenderPicker } from "./sender-picker";

export type ComposerMessage = {
  /** The user's own words: instructions the secretary follows. */
  typed: string;
  /** Pasted text: someone else's words, never followed as instructions. */
  pasted: string[];
  source: Source;
  senderPersonId: string | null;
};

type Block = { id: number; text: string };

/**
 * Message box for threads (design.md D22). Every paste becomes a quoted block so
 * text from other people is kept apart from what the user types.
 */
export function Composer({
  onSend,
  busy,
  progress,
  onCancel,
  withSender = false,
  defaultSource = "teams",
  placeholder,
  banner,
  compact = false,
}: {
  onSend: (message: ComposerMessage) => void;
  busy: boolean;
  progress?: string | null;
  onCancel?: () => void;
  /** New threads ask who the pasted text is from. */
  withSender?: boolean;
  defaultSource?: Source;
  placeholder?: string;
  banner?: ReactNode;
  compact?: boolean;
}) {
  const [typed, setTyped] = useState("");
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [source, setSource] = useState<Source>(defaultSource === "typed" ? "teams" : defaultSource);
  const [sender, setSender] = useState<string | null>(null);
  const people = usePeople().data ?? [];
  const canSend = !busy && (typed.trim() !== "" || blocks.length > 0);

  const send = () => {
    if (!canSend) return;
    onSend({
      typed: typed.trim(),
      pasted: blocks.map((b) => b.text),
      source,
      senderPersonId: blocks.length ? sender : null,
    });
    setTyped("");
    setBlocks([]);
    setSender(null);
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-background p-2">
      {banner}
      {blocks.map((b) => (
        <div key={b.id} className="flex gap-2 rounded-md border bg-muted/40 p-2 text-xs">
          <ClipboardPaste className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <p className="line-clamp-4 min-w-0 flex-1 whitespace-pre-wrap">{b.text}</p>
          <div className="flex shrink-0 flex-col gap-1">
            <Button
              size="icon"
              variant="ghost"
              className="size-6"
              aria-label="Remove pasted text"
              onClick={() => setBlocks((all) => all.filter((x) => x.id !== b.id))}
            >
              <X />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              className="size-6"
              aria-label="Use as my own words"
              title="Use as my own words (the secretary will follow it as an instruction)"
              onClick={() => {
                setTyped((t) => (t ? `${t}\n${b.text}` : b.text));
                setBlocks((all) => all.filter((x) => x.id !== b.id));
              }}
            >
              <Type />
            </Button>
          </div>
        </div>
      ))}
      <Textarea
        aria-label="Message"
        className="min-h-0 resize-none border-0 shadow-none focus-visible:ring-0"
        rows={compact ? 2 : 3}
        placeholder={
          placeholder ??
          "Paste a message, email or notes, and type what you want done. Pasted text is quoted; only your typing is taken as instructions."
        }
        value={typed}
        disabled={busy}
        onChange={(e) => setTyped(e.target.value)}
        onPaste={(e) => {
          const text = e.clipboardData.getData("text/plain");
          if (!text.trim()) return;
          e.preventDefault();
          setBlocks((all) => [...all, { id: Date.now() + all.length, text }]);
        }}
        onKeyDown={(e) => {
          if (isSubmitEnter(e)) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        {blocks.length > 0 && (
          <Select value={source} onValueChange={(v) => setSource(v as Source)}>
            <SelectTrigger size="sm" className="w-36" aria-label="Where the pasted text is from">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SOURCES.filter((s) => s !== "typed").map((s) => (
                <SelectItem key={s} value={s}>
                  {SOURCE_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {withSender && blocks.length > 0 && (
          <SenderPicker people={people} value={sender} onChange={setSender} />
        )}
        <span className={cn("ml-auto text-xs text-muted-foreground", busy && "animate-pulse")}>
          {busy
            ? (progress ?? "Working...")
            : "Nothing is written until you approve. Enter to send, Shift+Enter for a new line."}
        </span>
        {busy && onCancel && (
          <Button size="sm" variant="outline" onClick={onCancel}>
            <X /> Cancel
          </Button>
        )}
        <Button size="sm" disabled={!canSend} onClick={send}>
          {busy ? <Loader2 className="animate-spin" /> : <CornerDownLeft />}
          Send
        </Button>
      </div>
    </div>
  );
}

/** Maps a composed message to the first turn of a new thread. */
export function toTriageInput(m: ComposerMessage) {
  const pasted = m.pasted.join("\n\n");
  return pasted
    ? {
        text: pasted,
        instruction: m.typed || null,
        source: m.source,
        senderPersonId: m.senderPersonId,
      }
    : { text: m.typed, instruction: null, source: "typed" as const, senderPersonId: null };
}

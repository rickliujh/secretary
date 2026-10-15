import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { Placeholder } from "@tiptap/extensions/placeholder";
import { UndoRedo } from "@tiptap/extensions/undo-redo";
import { type Editor, EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { CornerDownLeft, Loader2, Type, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { isMac } from "@/app/platform";
import { usePeople } from "@/app/queries";
import { SOURCE_LABELS } from "@/components/labels";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { TriageInput } from "@/services/intake";
import { SOURCES, type Source } from "@/services/intake";
import { hasInput, type MessagePart } from "@/services/intake/thread";
import { docToParts } from "./message-doc";
import { ComposerKeymap, Pasted, pastedRunsAt, sendMessage, unmarkPasted } from "./pasted-mark";
import { SenderPicker } from "./sender-picker";

export type ComposerMessage = {
  /**
   * The message in order (D56): typed parts are the user's own words, pasted
   * parts someone else's text, never followed as instructions.
   */
  parts: MessagePart[];
  /** Where the pasted input is from; used only when the message has input. */
  source: Source;
  senderPersonId: string | null;
};

const MOD = isMac ? "Cmd" : "Ctrl";

/**
 * Message box for threads (design.md D22, D56). Pasted text stays where it was
 * pasted, highlighted and editable, and is sent as pasted parts so the
 * secretary treats it as someone else's words.
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
  const [parts, setParts] = useState<MessagePart[]>([]);
  const [source, setSource] = useState<Source>(defaultSource === "typed" ? "teams" : defaultSource);
  const [sender, setSender] = useState<string | null>(null);
  const people = usePeople().data ?? [];
  const withInput = hasInput(parts, true);
  const canSend = !busy && parts.some((p) => p.text.trim() !== "");

  const sendRef = useRef<() => void>(() => undefined);
  // Built once: useEditor resets the editor's options whenever these change.
  const options = useMemo(
    () => ({
      extensions: [
        Document,
        Paragraph,
        Text,
        HardBreak.configure({ keepMarks: false }),
        UndoRedo,
        Placeholder.configure({
          placeholder:
            placeholder ??
            "Paste a message, email or notes, and type what you want done. Pasted text is highlighted; only your typing is taken as instructions.",
        }),
        Pasted,
        ComposerKeymap.configure({ send: () => sendRef.current() }),
      ],
      editorProps: {
        attributes: {
          "aria-label": "Message",
          "aria-multiline": "true",
          role: "textbox",
          class: cn(
            "message-box max-h-64 w-full overflow-y-auto px-2.5 py-2 text-base break-words whitespace-pre-wrap outline-none md:text-sm",
            compact ? "min-h-14" : "min-h-19",
          ),
        },
      },
      onUpdate: ({ editor: e }: { editor: Editor }) => setParts(docToParts(e.getJSON())),
    }),
    [placeholder, compact],
  );
  const editor = useEditor(options);

  const inPaste =
    useEditorState({
      editor,
      selector: ({ editor: e }) =>
        !!e && pastedRunsAt(e.state, e.state.selection.from, e.state.selection.to).length > 0,
    }) ?? false;

  useEffect(() => {
    editor?.setEditable(!busy);
  }, [editor, busy]);

  const send = () => {
    if (busy || !editor) return;
    // Reads the editor, not state: Enter can come before the last keystroke renders.
    const sent = sendMessage(editor.view, (now) =>
      onSend({ parts: now, source, senderPersonId: hasInput(now, true) ? sender : null }),
    );
    if (sent) setSender(null);
  };
  sendRef.current = send;

  return (
    <div className="flex flex-col gap-2 rounded-lg border bg-background p-2">
      {banner}
      <EditorContent
        editor={editor}
        className={cn(busy && "pointer-events-none cursor-not-allowed opacity-50")}
      />
      <div className="flex flex-wrap items-center gap-2">
        {inPaste && !busy && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                // Keeps the cursor in the paste so the button knows which one.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => editor && unmarkPasted(editor.state, editor.view.dispatch)}
              >
                <Type /> Use as my own words
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              The secretary will follow it as an instruction. <Kbd>{MOD}+Shift+O</Kbd>
            </TooltipContent>
          </Tooltip>
        )}
        {withInput && (
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
        {withSender && withInput && (
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
export function toTriageInput(m: ComposerMessage): Omit<TriageInput, "onProgress"> {
  return { parts: m.parts, source: m.source, senderPersonId: m.senderPersonId };
}

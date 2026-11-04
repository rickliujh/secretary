import Document from "@tiptap/extension-document";
import HardBreak from "@tiptap/extension-hard-break";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { Placeholder } from "@tiptap/extensions/placeholder";
import { UndoRedo } from "@tiptap/extensions/undo-redo";
import { type Editor, EditorContent, useEditor, useEditorState } from "@tiptap/react";
import { CornerDownLeft, ListPlus, Type, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { runStore, useDrafts, useRuns } from "@/app/intake-runs";
import { isMac } from "@/app/platform";
import { usePeople } from "@/app/queries";
import { SOURCE_LABELS } from "@/components/labels";
import { Badge } from "@/components/ui/badge";
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
import type { TriageInput, TurnControl } from "@/services/intake";
import { SOURCES, type Source } from "@/services/intake";
import { hasInput, type MessagePart } from "@/services/intake/thread";
import { docToParts, partsToDoc } from "./message-doc";
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

/** A message's text in one line, for the queued chip. */
const oneLine = (parts: readonly MessagePart[]) => {
  const text = parts
    .map((p) => p.text)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
};

/**
 * Message box for threads (design.md D22, D56). Pasted text stays where it was
 * pasted, highlighted and editable, and is sent as pasted parts so the
 * secretary treats it as someone else's words. It never waits for a run (D68):
 * a message sent while one is going is queued behind it, shown as a chip with
 * remove, and Edit on a running message puts its text back here (`lane`).
 */
export function Composer({
  onSend,
  busy = false,
  lane,
  withSender = false,
  defaultSource = "teams",
  placeholder,
  banner,
  compact = false,
}: {
  onSend: (message: ComposerMessage) => void;
  /** A run is going: Send reads Queue (FR-21.1). */
  busy?: boolean;
  /** The run store lane it sends into: its queued messages and Edit's text (D68). */
  lane?: string;
  /** New threads ask who the pasted text is from. */
  withSender?: boolean;
  defaultSource?: Source;
  placeholder?: string;
  banner?: ReactNode;
  compact?: boolean;
}) {
  const [parts, setParts] = useState<MessagePart[]>([]);
  const [source, setSource] = useState<Source>(
    defaultSource === "typed" || defaultSource === "note" ? "teams" : defaultSource,
  );
  const [sender, setSender] = useState<string | null>(null);
  const people = usePeople().data ?? [];
  const withInput = hasInput(parts, true);
  const canSend = parts.some((p) => p.text.trim() !== "");
  const runs = useRuns();
  const queued = lane ? runs.filter((r) => r.state === "queued" && r.lane === lane) : [];
  const drafts = useDrafts();

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

  // Text given back (Edit, corrections after a stop, a queue kept over a restart,
  // D68) goes into the box, after what it already holds.
  useEffect(() => {
    if (!editor || !lane || drafts < 0 || !runStore.hasDraft(lane)) return;
    const back = runStore.takeDraft(lane);
    if (!back) return;
    const held = docToParts(editor.getJSON());
    editor.commands.setContent(
      partsToDoc(held.length ? [...held, { type: "typed", text: "\n" }, ...back] : back),
    );
    setParts(docToParts(editor.getJSON()));
    editor.commands.focus("end");
  }, [editor, lane, drafts]);

  const send = () => {
    if (!editor) return;
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
      {queued.map((r) => (
        <div key={r.id} className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="secondary">queued</Badge>
          <span className="min-w-0 truncate">
            “{oneLine(r.parts)}” · sent when the run before it ends
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-1.5 text-xs"
            onClick={() => runStore.stop(r.id)}
          >
            <X /> Remove
          </Button>
        </div>
      ))}
      <EditorContent editor={editor} />
      <div className="flex flex-wrap items-center gap-2">
        {inPaste && (
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
              {SOURCES.filter((s) => s !== "typed" && s !== "note").map((s) => (
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
        <span className="ml-auto text-xs text-muted-foreground">
          {busy
            ? "Esc stops the run. A message sent now waits its turn."
            : "Nothing is written until you approve. Enter to send, Shift+Enter for a new line."}
        </span>
        <Button size="sm" disabled={!canSend} onClick={send}>
          {busy ? <ListPlus /> : <CornerDownLeft />}
          {busy ? "Queue" : "Send"}
        </Button>
      </div>
    </div>
  );
}

/** Maps a composed message to the first turn of a new thread. */
export function toTriageInput(m: ComposerMessage): Omit<TriageInput, keyof TurnControl> {
  return { parts: m.parts, source: m.source, senderPersonId: m.senderPersonId };
}

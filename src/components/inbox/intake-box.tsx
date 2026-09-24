import { Loader2, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { SOURCES, type Source } from "@/services/intake";
import { SenderPicker } from "./sender-picker";
import { useLookups, useTriage } from "./use-inbox";

const SOURCE_LABELS: Record<Source, string> = {
  teams: "Teams",
  email: "Email",
  meeting: "Meeting notes",
  typed: "Typed",
  other: "Other",
};

/** Paste or type anything; the secretary proposes actions for approval (FR-2.1). */
export function IntakeBox({
  onTriaged,
  compact = false,
}: {
  onTriaged?: (inboxItemId: string) => void;
  compact?: boolean;
}) {
  const [text, setText] = useState("");
  const [source, setSource] = useState<Source>("teams");
  const [sender, setSender] = useState<string | null>(null);
  const { people } = useLookups();
  const triage = useTriage((id) => {
    setText("");
    setSender(null);
    onTriaged?.(id);
  });
  const submit = () => text.trim() && triage.mutate({ text, source, senderPersonId: sender });
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3">
      <Textarea
        aria-label="Input to triage"
        placeholder="Paste a Teams message, an email or meeting notes, or type an update..."
        rows={compact ? 3 : 6}
        value={text}
        disabled={triage.isPending}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit();
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select value={source} onValueChange={(v) => setSource(v as Source)}>
          <SelectTrigger size="sm" className="w-36" aria-label="Source">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SOURCES.map((s) => (
              <SelectItem key={s} value={s}>
                {SOURCE_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <SenderPicker people={people} value={sender} onChange={setSender} />
        <span className="ml-auto text-xs text-muted-foreground">
          {triage.isPending
            ? (triage.progress ?? "Working...")
            : "Nothing is written until you approve. Ctrl+Enter to triage."}
        </span>
        {triage.isPending ? (
          <Button size="sm" variant="outline" onClick={triage.cancel}>
            <X /> Cancel
          </Button>
        ) : null}
        <Button size="sm" disabled={!text.trim() || triage.isPending} onClick={submit}>
          {triage.isPending ? <Loader2 className="animate-spin" /> : <Sparkles />}
          Triage
        </Button>
      </div>
    </div>
  );
}

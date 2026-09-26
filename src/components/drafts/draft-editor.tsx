import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertCircle, Check, Copy, Loader2, RefreshCw, Send, Sparkles, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { CHANNEL_LABELS, intentLabel } from "@/components/labels";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { dateTime, relativeTime } from "@/lib/time";
import { type DraftDetail, draftDetail } from "@/services/comms/queries";
import { useDraftActions } from "./use-drafts";

type Variant = "short" | "standard";

export function DraftEditor({
  id,
  write,
  onDeleted,
}: {
  id: string;
  write: boolean;
  onDeleted: () => void;
}) {
  const detail = useQuery({
    queryKey: queryKeys.draft(id),
    queryFn: ({ signal }) => run(draftDetail(id), signal),
  });
  const actions = useDraftActions(id);
  const started = useRef(false);
  const d = detail.data;

  // Opened from "Write draft" or "Draft a chase": write it straight away, once.
  useEffect(() => {
    if (!write || started.current || !d || d.draft.variants || d.draft.status === "sent") return;
    started.current = true;
    actions.generate.mutate(null);
  }, [write, d, actions.generate]);

  if (detail.isPending) return <Loader2 className="m-6 animate-spin text-muted-foreground" />;
  if (!d) return <p className="p-6 text-sm text-muted-foreground">This draft no longer exists.</p>;

  const recipient = d.person?.displayName ?? d.team?.name ?? "No recipient";
  const failure = actions.generate.error as { message?: string; issues?: readonly string[] } | null;

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="outline">{CHANNEL_LABELS[d.draft.kind]}</Badge>
          <Badge variant="secondary">{d.draft.status}</Badge>
          {d.draft.language && <span>{d.draft.language}</span>}
          <span title={dateTime(d.draft.createdAt)}>{relativeTime(d.draft.createdAt)}</span>
        </div>
        <h2 className="text-lg font-semibold">
          {intentLabel(d.draft.intent)} to {recipient}
        </h2>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {d.draft.issueKeys.map((k) => (
            <Link key={k} to="/tickets" search={{ key: k }} className="font-mono text-xs underline">
              {k}
            </Link>
          ))}
          {d.dependency && (
            <Link
              to="/waiting"
              search={{ id: d.dependency.id }}
              className="text-muted-foreground underline"
            >
              waiting on {d.dependency.label}
              {d.dependency.externalRef ? ` (${d.dependency.externalRef})` : ""}
            </Link>
          )}
        </div>
      </header>

      {d.draft.notesMd && (
        <div className="rounded-lg border bg-muted/40 p-3 text-sm">
          <p className="mb-1 text-xs text-muted-foreground">What it should say</p>
          <p className="whitespace-pre-wrap">{d.draft.notesMd}</p>
        </div>
      )}

      {actions.generate.isPending && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Writing in {recipient}'s style...
        </p>
      )}
      {failure && !actions.generate.isPending && (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>No usable draft this time</AlertTitle>
          <AlertDescription>
            <p>{failure.message}</p>
            {failure.issues?.length ? (
              <ul className="list-disc pl-4">
                {failure.issues.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            ) : null}
          </AlertDescription>
        </Alert>
      )}

      {d.draft.variants ? (
        <Body key={d.draft.generatedAt ?? ""} detail={d} actions={actions} onDeleted={onDeleted} />
      ) : (
        !actions.generate.isPending && (
          <div className="flex gap-2">
            <Button onClick={() => actions.generate.mutate(null)}>
              <Sparkles /> Write draft
            </Button>
            <Button
              variant="ghost"
              onClick={() => actions.remove.mutate(undefined, { onSuccess: onDeleted })}
            >
              <Trash2 /> Delete
            </Button>
          </div>
        )
      )}

      {d.recent.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Recently sent to {recipient}</h3>
          {d.recent.map((m) => (
            <div key={m.id} className="rounded-lg border p-3 text-sm">
              <p className="mb-1 text-xs text-muted-foreground">
                {m.sentAt ? dateTime(m.sentAt) : ""}
                {m.subject ? ` · ${m.subject}` : ""}
              </p>
              <p className="line-clamp-4 whitespace-pre-wrap">{m.bodyMd}</p>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

function Body({
  detail: d,
  actions,
  onDeleted,
}: {
  detail: DraftDetail;
  actions: ReturnType<typeof useDraftActions>;
  onDeleted: () => void;
}) {
  const generated = d.draft.variants ?? { short: "", standard: "" };
  const [variant, setVariant] = useState<Variant>(d.draft.variant ?? "standard");
  // Each variant keeps its own edits; the chosen one starts from what was saved.
  const [texts, setTexts] = useState<Record<Variant, string>>({
    ...generated,
    [d.draft.variant ?? "standard"]: d.draft.bodyMd || generated[d.draft.variant ?? "standard"],
  });
  const [subject, setSubject] = useState(d.draft.subject ?? "");
  const [instruction, setInstruction] = useState("");
  const sent = d.draft.status === "sent";
  const email = d.draft.kind === "email";
  const dirty =
    texts[variant] !== d.draft.bodyMd ||
    variant !== (d.draft.variant ?? "standard") ||
    (email && subject !== (d.draft.subject ?? ""));

  const save = () =>
    dirty
      ? actions.save.mutateAsync({
          variant,
          subject: email ? subject : null,
          bodyMd: texts[variant],
        })
      : Promise.resolve();

  return (
    <div className="flex flex-col gap-3">
      <Tabs value={variant} onValueChange={(v) => setVariant(v as Variant)}>
        <TabsList>
          <TabsTrigger value="short">Short</TabsTrigger>
          <TabsTrigger value="standard">Standard</TabsTrigger>
        </TabsList>
      </Tabs>
      {email && (
        <Input
          aria-label="Subject"
          value={subject}
          readOnly={sent}
          onChange={(e) => setSubject(e.target.value)}
          onBlur={() => void save()}
        />
      )}
      <Textarea
        aria-label="Message"
        className="min-h-48"
        value={texts[variant]}
        readOnly={sent}
        onChange={(e) => setTexts((t) => ({ ...t, [variant]: e.target.value }))}
        onBlur={() => void save()}
      />
      {sent ? (
        <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-300">
          <Check className="size-4" /> Sent {d.draft.sentAt ? dateTime(d.draft.sentAt) : ""}
          {d.dependency && " · logged as a follow-up"}
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={actions.copy.isPending}
              onClick={async () => {
                await save();
                actions.copy.mutate(texts[variant]);
              }}
            >
              <Copy /> Copy message
            </Button>
            {email && (
              <Button variant="outline" onClick={() => actions.copy.mutate(subject)}>
                <Copy /> Copy subject
              </Button>
            )}
            <Button
              variant="outline"
              disabled={actions.sent.isPending}
              onClick={async () => {
                await save();
                actions.sent.mutate(undefined);
              }}
            >
              <Send /> Mark sent
            </Button>
            <Button
              variant="ghost"
              onClick={() => actions.remove.mutate(undefined, { onSuccess: onDeleted })}
            >
              <Trash2 /> Delete
            </Button>
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex gap-2">
              <Input
                aria-label="What should change"
                placeholder="What should change? e.g. more direct, mention Friday's release"
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !actions.generate.isPending) {
                    actions.generate.mutate(instruction.trim() || null);
                    setInstruction("");
                  }
                }}
              />
              <Button
                variant="outline"
                disabled={actions.generate.isPending}
                onClick={() => {
                  actions.generate.mutate(instruction.trim() || null);
                  setInstruction("");
                }}
              >
                {actions.generate.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                Rewrite
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Rewriting replaces both variants, including your edits.
              {d.draft.instructions.length > 0 &&
                ` Asked so far: ${d.draft.instructions.map((i) => `"${i}"`).join(", ")}.`}
            </p>
          </div>
        </>
      )}
    </div>
  );
}

import { useMutation } from "@tanstack/react-query";
import { Effect } from "effect";
import { Loader2, Play } from "lucide-react";
import { useRef, useState } from "react";
import { isInterrupted } from "@/app/errors";
import { useErrorToast } from "@/app/hooks";
import { run } from "@/app/runtime";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Learning, type ReplayResult } from "@/services/learning";
import type { TestTarget } from "@/services/llm";
import { TIERS } from "@/services/llm/tasks";
import { PROPOSAL_LABELS } from "@/services/proposals/schema";
import type { AppSettings } from "@/services/settings";

const pct = (n: number, d: number) => (d ? `${Math.round((n / d) * 100)}%` : "–");

/**
 * Evaluation replay (FR-9.4): how would another tier or model have handled the
 * items you already decided? Uses the stored snapshots, so only the model varies.
 */
export function ReplayCard({ settings }: { settings: AppSettings }) {
  const onError = useErrorToast();
  const [choice, setChoice] = useState<string>("tier:standard");
  const [model, setModel] = useState("");
  const [limit, setLimit] = useState("30");
  const [progress, setProgress] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const replay = useMutation({
    mutationFn: (target: TestTarget) => {
      controller.current = new AbortController();
      return run(
        Effect.flatMap(Learning, (l) =>
          l.replay({
            target,
            limit: Math.max(1, Math.min(200, Number(limit) || 30)),
            onProgress: (done, total) => setProgress(`${done} of ${total}`),
          }),
        ),
        controller.current.signal,
      );
    },
    onError: (e) => {
      if (!isInterrupted(e)) onError(e);
    },
    onSettled: () => setProgress(null),
  });

  const [kind, id] = choice.split(":") as ["tier" | "provider", string];
  const target: TestTarget | null =
    kind === "tier"
      ? { tier: id as (typeof TIERS)[number] }
      : model.trim()
        ? { providerId: id, model: model.trim() }
        : null;
  const r: ReplayResult | undefined = replay.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Evaluation replay</CardTitle>
        <CardDescription>
          Runs the inbox items you already decided again on another tier or model, from what the
          secretary saw at the time, and shows how often it proposes what you approved.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <Field className="w-56">
            <FieldLabel htmlFor="replay-target">Model</FieldLabel>
            <Select value={choice} onValueChange={setChoice}>
              <SelectTrigger id="replay-target">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIERS.filter((t) => settings.tiers[t]).map((t) => (
                  <SelectItem key={t} value={`tier:${t}`}>
                    {t} tier ({settings.tiers[t]?.model})
                  </SelectItem>
                ))}
                {settings.providers.map((p) => (
                  <SelectItem key={p.id} value={`provider:${p.id}`}>
                    Another model on {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {kind === "provider" && (
            <Field className="w-56">
              <FieldLabel htmlFor="replay-model">Model name</FieldLabel>
              <Input id="replay-model" value={model} onChange={(e) => setModel(e.target.value)} />
            </Field>
          )}
          <Field className="w-24">
            <FieldLabel htmlFor="replay-limit">Items</FieldLabel>
            <Input
              id="replay-limit"
              inputMode="numeric"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
            />
          </Field>
          {replay.isPending ? (
            <Button variant="outline" onClick={() => controller.current?.abort()}>
              <Loader2 className="animate-spin" /> {progress ?? "Starting"} · Stop
            </Button>
          ) : (
            <Button disabled={!target} onClick={() => target && replay.mutate(target)}>
              <Play /> Replay
            </Button>
          )}
        </div>
        {r && (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              {r.items} item{r.items === 1 ? "" : "s"} on {r.model || "the chosen model"}
              {r.failed ? `; ${r.failed} gave no valid answer` : ""}.
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Proposal</TableHead>
                  <TableHead className="text-right">You approved</TableHead>
                  <TableHead className="text-right">Proposed again</TableHead>
                  <TableHead className="text-right">Repeated rejections</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.byKind.map((k) => (
                  <TableRow key={k.kind}>
                    <TableCell>{PROPOSAL_LABELS[k.kind]}</TableCell>
                    <TableCell className="text-right">{k.approved}</TableCell>
                    <TableCell className="text-right">
                      {k.matched} ({pct(k.matched, k.approved)})
                    </TableCell>
                    <TableCell className="text-right">{k.repeatedRejections}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

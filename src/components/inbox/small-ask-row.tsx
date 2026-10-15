import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Loader2, RotateCcw, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Lookups } from "@/app/queries";
import { run } from "@/app/runtime";
import { IssueCombobox } from "@/components/tickets/issue-combobox";
import { TicketLink } from "@/components/tickets/ticket-link";
import { TONE } from "@/components/tone";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { ProposalView } from "@/services/inbox/queries";
import { type PayloadOf, type ProposalPayload, StoryPoints } from "@/services/proposals/schema";
import { bundleLine, trackOrder } from "@/services/small-asks/bundle";
import { isSubtaskType } from "@/services/small-asks/home";
import { smallAskHome } from "@/services/small-asks/queries";
import { ProposalCard } from "./proposal-card";
import { editedPoints, issueOptions } from "./proposal-fields";
import { RevokeControl, RevokeOutcome } from "./revoke-control";
import { SMALL_ASK_KEYS } from "./small-ask-keys";
import { SprintChip } from "./sprint-choice";
import { useDecisions, useSavingEdit, useTurnRunning } from "./use-inbox";
import { useThreadSprintFits } from "./use-sprint-fit";

type Result = { message?: string; error?: string; issueKey?: string; warning?: string } | null;

const pointsText = (n: number | null) => (n === null ? "" : String(n));

/** The points field's text: null when empty, undefined when it is not a valid number of points. */
function parsePointsInput(text: string): number | null | undefined {
  const t = text.trim();
  if (!t) return null;
  const r = StoryPoints.safeParse(Number(t));
  return r.success ? r.data : undefined;
}

/**
 * A small ask as one compact row (FR-10.3, D44): summary, type and epic (both
 * changeable), what it waits on, and Track, which approves the ticket and what
 * hangs on it in order. The full cards are one click away.
 */
export function SmallAskRow({
  create,
  members,
  lookups,
}: {
  create: ProposalView;
  members: ProposalView[];
  lookups: Lookups;
}) {
  const { track, reject, saveEdit } = useDecisions();
  const home = useQuery({
    queryKey: SMALL_ASK_KEYS.home,
    queryFn: ({ signal }) => run(smallAskHome, signal),
  });
  const payload = (create.editedPayload ?? create.payload) as PayloadOf<"create_issue">;
  const storedPoints = typeof payload.storyPoints === "number" ? payload.storyPoints : null;
  const [issueType, setIssueType] = useState(payload.issueType);
  const [epic, setEpic] = useState(payload.epic ?? "");
  const [points, setPoints] = useState(pointsText(storedPoints));
  const [join, setJoin] = useState(payload.joinSprint);
  const [open, setOpen] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  // A reply in the thread can replace the proposal; start again from the new one.
  useEffect(() => {
    setIssueType(payload.issueType);
    setEpic(payload.epic ?? "");
    setPoints(pointsText(storedPoints));
    setJoin(payload.joinSprint);
  }, [payload.issueType, payload.epic, storedPoints, payload.joinSprint]);

  const subtask = isSubtaskType(payload.issueType, home.data?.home?.subtaskTypes);
  const fits = useThreadSprintFits(create.inboxItemId);
  const types = [...new Set([...(home.data?.home?.issueTypes ?? []), payload.issueType])];
  const ids = trackOrder(create, members);
  const createOpen = create.status === "pending" || create.status === "failed";
  const pendingIds = [create, ...members].filter((p) => p.status === "pending").map((p) => p.id);
  // A save from the expanded card's switch counts too, and a running turn locks the chip (D57).
  const saving = useSavingEdit({ id: create.id });
  const turn = useTurnRunning(create.inboxItemId);
  const busy = track.isPending || saveEdit.isPending || saving || rejecting;
  const result = create.result as Result;
  const failed = [create, ...members].filter((p) => p.status === "failed");
  const warnings = [create, ...members]
    .map((p) => (p.result as Result)?.warning)
    .filter((w): w is string => !!w);
  // Every member Track runs gets a line on the face (D44).
  const lines = members.map((m) => ({
    id: m.id,
    status: m.status,
    text: bundleLine((m.editedPayload ?? m.payload) as ProposalPayload, payload.ref) ?? m.kind,
  }));
  const requester = payload.requesterPersonId
    ? (lookups.person.get(payload.requesterPersonId)?.displayName ?? null)
    : null;

  type RowValues = { issueType: string; epic: string; points: number | null; join: boolean };
  const current = (): RowValues => {
    const typed = parsePointsInput(points);
    return { issueType, epic, points: typed === undefined ? storedPoints : typed, join };
  };
  /** The create with the row's values; points the user changed are no longer a suggestion (D55). */
  const edited = (v: RowValues): ProposalPayload => ({
    ...payload,
    issueType: v.issueType,
    epic: v.epic || null,
    // The sprint switch the user set is kept through revisions (D57).
    ...(v.join !== payload.joinSprint ? { joinSprint: v.join, joinSprintChosen: true } : {}),
    ...(editedPoints(payload, { issueType: v.issueType, storyPoints: v.points }) as {
      storyPoints: number | null;
      storyPointsEstimated: boolean;
      storyPointsCleared: boolean;
    }),
  });
  const reset = () => {
    setIssueType(payload.issueType);
    setEpic(payload.epic ?? "");
    setPoints(pointsText(storedPoints));
    setJoin(payload.joinSprint);
  };
  // A change is saved on the pending create at once, so its card, Approve all and
  // Track all use it (D44). A failed create sends its changes with Retry instead.
  const change = (next: RowValues) => {
    setIssueType(next.issueType);
    setEpic(next.epic);
    setPoints(pointsText(next.points));
    setJoin(next.join);
    if (create.status !== "pending") return;
    saveEdit.mutate(
      { id: create.id, inboxItemId: create.inboxItemId, edited: edited(next) },
      { onError: reset },
    );
  };
  /** The points field saves when it is left or Enter is pressed; text that is no number is undone. */
  const commitPoints = () => {
    const parsed = parsePointsInput(points);
    if (parsed === undefined) return setPoints(pointsText(storedPoints));
    if (parsed !== storedPoints) change({ ...current(), points: parsed });
  };
  const onTrack = () => {
    const v = current();
    const changed =
      v.issueType !== payload.issueType ||
      (v.epic || null) !== payload.epic ||
      v.points !== storedPoints ||
      v.join !== payload.joinSprint;
    // Row changes are an edit of the create, recorded like any other (FR-7.2).
    const edits: Record<string, ProposalPayload> =
      changed && createOpen ? { [create.id]: edited(v) } : {};
    track.mutate({ ids, edits });
  };
  const onReject = async () => {
    setRejecting(true);
    try {
      // Members first, so nothing is left pointing at a rejected create.
      for (const id of [...pendingIds].reverse()) await reject.mutateAsync(id);
    } finally {
      setRejecting(false);
    }
  };

  return (
    <article
      aria-label={`Small ask: ${payload.summary}, ${create.status}`}
      className={cn(
        "flex flex-col gap-2 rounded-lg border p-3",
        (create.status === "rejected" || create.status === "revoked") && "opacity-75",
      )}
    >
      <header className="flex min-w-0 items-center gap-2">
        <Badge variant="secondary">Small ask</Badge>
        <span className="min-w-0 truncate font-medium">{payload.summary}</span>
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {[payload.dueDate && `due ${payload.dueDate}`, requester && `asked by ${requester}`]
            .filter(Boolean)
            .join(" · ")}
        </span>
      </header>
      {lines.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          {lines.map((l) => (
            <li key={l.id}>
              {l.text}
              {l.status !== "pending" && <span className="ml-1">({l.status})</span>}
            </li>
          ))}
        </ul>
      )}
      {createOpen && (
        <div className="flex flex-wrap items-center gap-2">
          {subtask ? (
            <Badge variant="outline">
              Sub-task of{" "}
              {payload.parent && <span className="ml-1 font-mono">{payload.parent}</span>}
            </Badge>
          ) : (
            <Select
              value={issueType}
              onValueChange={(t) => change({ ...current(), issueType: t })}
              disabled={busy}
            >
              <SelectTrigger size="sm" className="w-32" aria-label="Issue type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {types.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {!subtask && (
            <div className="w-64">
              <IssueCombobox
                value={epic}
                onChange={(e) => change({ ...current(), epic: e })}
                options={issueOptions(lookups.tickets, "epic", payload.projectKey)}
                placeholder="No epic"
                noneLabel="No epic"
              />
            </div>
          )}
          <Input
            type="number"
            min={0}
            step="any"
            inputMode="decimal"
            className="h-8 w-20"
            aria-label="Story points"
            placeholder="Points"
            value={points}
            disabled={busy}
            onChange={(e) => setPoints(e.target.value)}
            onBlur={commitPoints}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitPoints();
              }
            }}
          />
          {payload.storyPointsEstimated && storedPoints !== null && (
            <span className="text-xs text-muted-foreground">suggested</span>
          )}
          {!subtask && (
            <SprintChip
              choice={fits.data?.[create.id]}
              loading={fits.isPending && fits.fetchStatus !== "idle"}
              failed={fits.isError}
              checked={join}
              disabled={busy || turn}
              onChange={(j) => change({ ...current(), join: j })}
            />
          )}
          <span className="text-xs text-muted-foreground">in {payload.projectKey}</span>
          <span className="ml-auto" />
          <Button size="sm" disabled={busy || ids.length === 0} onClick={onTrack}>
            {track.isPending ? (
              <Loader2 className="animate-spin" />
            ) : create.status === "failed" ? (
              <RotateCcw />
            ) : (
              <Check />
            )}
            {create.status === "failed" ? "Retry" : "Track"}
          </Button>
          {create.status === "pending" && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={onReject}>
              <X /> Reject
            </Button>
          )}
        </div>
      )}
      {create.status === "executed" && (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant="secondary" className={cn("border-transparent", TONE.success)}>
            tracked
          </Badge>
          {result?.message}
          {result?.issueKey && (
            <TicketLink ticketKey={result.issueKey} className="underline">
              open
            </TicketLink>
          )}
          {ids.length > 0 && (
            <Button size="sm" variant="outline" disabled={busy} onClick={onTrack}>
              {track.isPending ? <Loader2 className="animate-spin" /> : <RotateCcw />}
              Run the rest
            </Button>
          )}
          <span className="ml-auto" />
          {/* Revoking the ticket revokes what hangs on it first: the bundle goes as one (D54). */}
          <RevokeControl proposal={create} />
        </p>
      )}
      {create.status === "revoked" && (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant="secondary" className={cn("border-transparent", TONE.neutral)}>
            revoked
          </Badge>
          {result?.issueKey && <span className="font-mono text-xs">{result.issueKey}</span>}
        </p>
      )}
      {(create.status === "executed" || create.status === "revoked") && (
        <RevokeOutcome result={create.result} />
      )}
      {create.status === "rejected" && <p className="text-sm text-muted-foreground">Rejected</p>}
      {warnings.map((w) => (
        <p key={w} className="text-sm text-amber-700 dark:text-amber-300">
          {w}
        </p>
      ))}
      {failed.map((p) => (
        <p key={p.id} className="text-sm text-destructive">
          {(p.result as Result)?.error}
        </p>
      ))}
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <Button size="sm" variant="ghost" className="h-6 px-1 text-xs text-muted-foreground">
            <ChevronDown className={cn("transition-transform", open && "rotate-180")} />
            {open ? "Hide details" : `Details (${members.length + 1})`}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 flex flex-col gap-2 border-l-2 pl-3">
          {[create, ...members].map((p) => (
            <ProposalCard key={p.id} proposal={p} lookups={lookups} />
          ))}
        </CollapsibleContent>
      </Collapsible>
    </article>
  );
}

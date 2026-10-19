/**
 * Triage against the current item in the Inbox (FR-19.8, D62): the "About
 * <item>" and "about what you're on" marks, Park with an optional reason, the
 * parked line and Bring back. Parking only sets the thread aside: its
 * proposals stay pending and undecided, and nothing is written to Jira.
 */
import { useQuery } from "@tanstack/react-query";
import { ArchiveRestore, PauseCircle, Star } from "lucide-react";
import { useState } from "react";
import { useAppMutation, useSettings } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { TONE } from "@/components/tone";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import { localDate } from "@/lib/dates";
import { shortDate } from "@/lib/time";
import { cn } from "@/lib/utils";
import { parkThread, type ThreadAbout, threadAbout, unparkThread } from "@/services/work/park";

/** Park and Bring back refresh the Inbox, Today (under tickets) and the Work tab's timeline. */
const PARK_KEYS = [queryKeys.inbox, queryKeys.tickets];

/** Whether the Inbox triages against the current item (Settings > Secretary). */
export function useParkInput() {
  const { data: settings } = useSettings();
  return (settings?.secretary.parkInput ?? false) && (settings?.work.enabled ?? false);
}

export function useParkActions() {
  const park = useAppMutation(
    (i: { id: string; reason: string }) => parkThread(i.id, i.reason || null),
    {
      invalidate: PARK_KEYS,
      success: (r) =>
        r ? "Parked until you are done" : "Nothing to park: it is not about other work",
    },
  );
  const bringBack = useAppMutation((id: string) => unparkThread(id, "brought back by you", "me"), {
    invalidate: PARK_KEYS,
  });
  return { park, bringBack };
}

/** A thread's mark against the current item. */
export function AboutBadge({
  about,
  className,
}: {
  about: ThreadAbout | null;
  className?: string;
}) {
  if (!about) return null;
  if (about.kind === "current")
    return (
      <Badge
        variant="secondary"
        className={cn("h-4 gap-1 border-transparent px-1.5", TONE.info, className)}
      >
        <Star className="size-2.5 fill-current" /> about what you're on
      </Badge>
    );
  return (
    <Badge variant="outline" className={cn("h-4 max-w-48 px-1.5", className)}>
      <span className="truncate">About {about.name}</span>
    </Badge>
  );
}

function ParkButton({ id, about }: { id: string; about: Extract<ThreadAbout, { kind: "other" }> }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const { park } = useParkActions();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="outline">
          <PauseCircle /> Park
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            park.mutate(
              { id, reason: reason.trim() },
              {
                onSuccess: () => {
                  setOpen(false);
                  setReason("");
                },
              },
            );
          }}
        >
          <PopoverHeader>
            <PopoverTitle>Park until you are done</PopoverTitle>
            <PopoverDescription>
              This is about {about.name}. It comes back when you finish or leave {about.current}, or
              tomorrow. Its proposals stay as they are.
            </PopoverDescription>
          </PopoverHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`park-${id}`}>Why (optional)</Label>
            <Input
              id={`park-${id}`}
              value={reason}
              maxLength={200}
              placeholder={`on ${about.current}`}
              onChange={(e) => setReason(e.target.value)}
              autoFocus
            />
          </div>
          <Button type="submit" size="sm" disabled={park.isPending}>
            <PauseCircle /> Park
          </Button>
        </form>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The thread header's line (D62): its mark and Park while an item is current,
 * the parked line with Bring back, or why it came back.
 */
export function ThreadPark({
  item,
  pending,
}: {
  item: {
    id: string;
    status: string;
    parkedReason: string | null;
    parkedUntil: string | null;
  };
  pending: number;
}) {
  const on = useParkInput();
  const today = localDate();
  const about = useQuery({
    queryKey: queryKeys.threadAbout(item.id, today),
    queryFn: ({ signal }) => run(threadAbout(item.id, today), signal),
    enabled: on,
  });
  const { bringBack } = useParkActions();
  if (item.status === "parked")
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <Badge variant="secondary" className={cn("border-transparent", TONE.neutral)}>
          Parked
        </Badge>
        <span>
          {item.parkedReason}
          {item.parkedUntil ? `; back by ${shortDate(item.parkedUntil)} at the latest` : ""}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          disabled={bringBack.isPending}
          onClick={() => bringBack.mutate(item.id)}
        >
          <ArchiveRestore /> Bring back
        </Button>
      </div>
    );
  const back = !!item.parkedReason && !item.parkedUntil && pending > 0;
  const a = on ? (about.data?.about ?? null) : null;
  if (!back && !a) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      {back && <span>Back from parking ({item.parkedReason}).</span>}
      <AboutBadge about={a} />
      {a?.kind === "other" && about.data?.canPark && <ParkButton id={item.id} about={a} />}
    </div>
  );
}

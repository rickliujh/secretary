import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { BriefPanel } from "@/components/dashboard/brief-panel";
import { EpicHealth } from "@/components/dashboard/epic-health";
import { FocusList } from "@/components/dashboard/focus-list";
import { useDashboard } from "@/components/dashboard/use-dashboard";
import { IntakeBox } from "@/components/inbox/intake-box";
import { StatusBadge } from "@/components/tickets/status-badge";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { relativeTime } from "@/lib/time";
import { pendingCount } from "@/services/inbox/queries";

export const Route = createFileRoute("/")({ component: Dashboard });

function Section({
  title,
  description,
  count,
  action,
  children,
}: {
  title: string;
  description?: string;
  count?: number;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {title}
          {count !== undefined && count > 0 && <Badge variant="secondary">{count}</Badge>}
        </CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
        {action && <CardAction>{action}</CardAction>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

const Empty = ({ children }: { children: ReactNode }) => (
  <p className="text-sm text-muted-foreground">{children}</p>
);

function IssueLine({
  issueKey,
  summary,
  right,
}: {
  issueKey: string;
  summary: string;
  right?: ReactNode;
}) {
  return (
    <li className="flex items-center gap-2 py-1 text-sm">
      <Link to="/tickets" search={{ key: issueKey }} className="font-mono text-xs underline">
        {issueKey}
      </Link>
      <span className="min-w-0 flex-1 truncate">{summary}</span>
      {right}
    </li>
  );
}

function Dashboard() {
  const navigate = useNavigate();
  const { data, isPending, isError } = useDashboard();
  const pending = useQuery({
    queryKey: queryKeys.pendingCount,
    queryFn: ({ signal }) => run(pendingCount, signal),
  });

  if (isPending) return <Loader2 className="m-6 animate-spin text-muted-foreground" />;
  if (isError || !data) return <Empty>The dashboard could not be loaded.</Empty>;
  const d = data.dashboard;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <BriefPanel brief={data.brief} fresh={data.briefFresh} />
      <IntakeBox compact onTriaged={(id) => navigate({ to: "/inbox", search: { item: id } })} />
      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Section
            title="Top focus"
            description={`Ranked from ${d.inScope} open tickets you own, pinned, under tracked epics or with dependencies${d.snoozed ? `; ${d.snoozed} snoozed` : ""}.`}
          >
            <FocusList items={d.topFocus} />
          </Section>
        </div>
        <div className="flex flex-col gap-4">
          <Section
            title="Waiting on me"
            description="New comments and mentions since you last looked."
            count={d.waitingOnMe.length}
          >
            {d.waitingOnMe.length === 0 ? (
              <Empty>Nothing new.</Empty>
            ) : (
              <ul>
                {d.waitingOnMe.map((w) => (
                  <IssueLine
                    key={w.issue.key}
                    issueKey={w.issue.key}
                    summary={w.issue.summary}
                    right={
                      <span className="text-xs text-muted-foreground">
                        {w.reasons[0]} {relativeTime(w.at)}
                      </span>
                    }
                  />
                ))}
              </ul>
            )}
          </Section>
          <Section
            title="I am waiting on"
            description="Overdue dependencies and follow-ups due."
            count={d.iAmWaitingOn.length}
            action={
              <Link to="/waiting" className="text-sm underline">
                All
              </Link>
            }
          >
            {d.iAmWaitingOn.length === 0 ? (
              <Empty>Nothing overdue.</Empty>
            ) : (
              <ul>
                {d.iAmWaitingOn.slice(0, 6).map((w) => (
                  <li key={w.id} className="flex items-center gap-2 py-1 text-sm">
                    <Link
                      to="/waiting"
                      search={{ id: w.id }}
                      className="min-w-0 flex-1 truncate underline"
                    >
                      {w.label}
                      {w.externalRef && <span className="font-mono text-xs"> {w.externalRef}</span>}
                    </Link>
                    <span className="text-xs text-muted-foreground">{w.ownerName}</span>
                    {w.overdueDays > 0 ? (
                      <Badge variant="destructive">{w.overdueDays}d</Badge>
                    ) : (
                      <Badge variant="secondary">chase</Badge>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Section title="At risk" description="Blocked, stale or late." count={d.atRisk.length}>
          {d.atRisk.length === 0 ? (
            <Empty>Nothing at risk.</Empty>
          ) : (
            <ul>
              {d.atRisk.map((r) => (
                <IssueLine
                  key={r.issue.key}
                  issueKey={r.issue.key}
                  summary={r.issue.summary}
                  right={
                    <span className="max-w-40 truncate text-xs text-muted-foreground">
                      {r.reasons.join("; ")}
                    </span>
                  }
                />
              ))}
            </ul>
          )}
        </Section>
        <Section
          title="Due soon"
          description="Within a week, and anything past due."
          count={d.dueSoon.length}
        >
          {d.dueSoon.length === 0 ? (
            <Empty>Nothing due this week.</Empty>
          ) : (
            <ul>
              {d.dueSoon.map((i) => (
                <IssueLine
                  key={i.key}
                  issueKey={i.key}
                  summary={i.summary}
                  right={
                    <>
                      <StatusBadge status={i.status} category={i.statusCategory} />
                      <Badge
                        variant={i.daysLeft < 0 ? "destructive" : "outline"}
                        className="tabular-nums"
                      >
                        {i.daysLeft < 0
                          ? `${-i.daysLeft}d late`
                          : i.daysLeft === 0
                            ? "today"
                            : `${i.daysLeft}d`}
                      </Badge>
                    </>
                  }
                />
              ))}
            </ul>
          )}
        </Section>
        <div className="flex flex-col gap-4">
          <Section title="Epic health">
            <EpicHealth epics={d.epicHealth} />
          </Section>
          <Section
            title="Inbox"
            action={
              <Link to="/inbox" className="text-sm underline">
                Open
              </Link>
            }
          >
            <p className="text-sm">
              {pending.data
                ? `${pending.data} proposal${pending.data === 1 ? "" : "s"} waiting for your decision.`
                : "No proposals waiting."}
            </p>
          </Section>
        </div>
      </div>
    </div>
  );
}

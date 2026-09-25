import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, Paperclip, Pencil, UserPlus } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { z } from "zod";
import { useSettings } from "@/app/hooks";
import { queryKeys } from "@/app/query-client";
import { run } from "@/app/runtime";
import { IssueDependencies } from "@/components/dependencies/issue-dependencies";
import { ContextNotes } from "@/components/directory/context-notes";
import { PersonDialog } from "@/components/directory/person-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { dateTime, relativeTime, shortDate } from "@/lib/time";
import { contactsByUsername } from "@/services/directory/queries";
import { normalizeUsername } from "@/services/directory/schema";
import { AttachmentSchema, IssueLinkSchema } from "@/services/jira";
import { markViewed, type TicketDetail, ticketDetail } from "@/services/tickets/queries";
import { JiraHtml } from "./jira-html";
import { StatusBadge } from "./status-badge";
import {
  AssignButton,
  CommentComposer,
  EditDialog,
  EpicSelect,
  TransitionSelect,
} from "./ticket-actions";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children ?? <span className="text-muted-foreground">None</span>}</dd>
    </>
  );
}

const rawList = <T,>(schema: z.ZodType<T>, value: unknown): T[] => {
  const r = z.array(schema).safeParse(value);
  return r.success ? r.data : [];
};

/** A Jira user shown as a link to their contact, or with a button to create one (FR-4 contact matching). */
function JiraUser({
  username,
  display,
  email,
}: {
  username: string | null;
  display: string | null;
  email: string | null;
}) {
  const [adding, setAdding] = useState(false);
  const contacts = useQuery({
    queryKey: queryKeys.contactsByUsername,
    queryFn: ({ signal }) => run(contactsByUsername, signal),
  });
  if (!username) return null;
  const contact = contacts.data?.get(normalizeUsername(username));
  if (contact) {
    return (
      <Link to="/people" search={{ id: contact.id }} className="underline">
        {contact.displayName}
      </Link>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      {display ?? username}
      <Button
        variant="ghost"
        size="icon"
        className="size-6"
        aria-label="Add as contact"
        title="Add as contact"
        onClick={() => setAdding(true)}
      >
        <UserPlus className="size-3.5" />
      </Button>
      <PersonDialog
        open={adding}
        onOpenChange={setAdding}
        initial={{ displayName: display ?? username, jiraUsername: username, email }}
      />
    </span>
  );
}

const rawEmail = (raw: unknown, field: "assignee" | "reporter") => {
  const r = z
    .object({ emailAddress: z.string() })
    .safeParse((raw as Record<string, unknown> | null)?.[field]);
  return r.success ? r.data.emailAddress : null;
};

function Details({ detail }: { detail: TicketDetail }) {
  const i = detail.issue;
  return (
    <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm">
      <Row label="Status">
        <StatusBadge status={i.status} category={i.statusCategory} />
      </Row>
      <Row label="Type">{i.issueType}</Row>
      <Row label="Priority">{i.priority}</Row>
      <Row label="Assignee">
        {i.assignee ? (
          <JiraUser
            username={i.assignee}
            display={i.assigneeDisplay}
            email={rawEmail(i.raw, "assignee")}
          />
        ) : null}
      </Row>
      <Row label="Reporter">
        {i.reporter ? (
          <JiraUser
            username={i.reporter}
            display={i.reporterDisplay}
            email={rawEmail(i.raw, "reporter")}
          />
        ) : null}
      </Row>
      <Row label="Epic">{i.epicKey}</Row>
      <Row label="Parent">{i.parentKey}</Row>
      <Row label="Sprint">{i.sprint}</Row>
      <Row label="Labels">
        {i.labels.length ? (
          <span className="flex flex-wrap gap-1">
            {i.labels.map((l) => (
              <Badge key={l} variant="outline">
                {l}
              </Badge>
            ))}
          </span>
        ) : null}
      </Row>
      <Row label="Components">{i.components.length ? i.components.join(", ") : null}</Row>
      <Row label="Due">{i.dueDate ? shortDate(i.dueDate) : null}</Row>
      <Row label="Created">{dateTime(i.created)}</Row>
      <Row label="Updated">
        {dateTime(i.updated)}{" "}
        <span className="text-muted-foreground">({relativeTime(i.updated)})</span>
      </Row>
      <Row label="Resolved">{i.resolved ? dateTime(i.resolved) : null}</Row>
      <Row label="Synced">{relativeTime(i.syncedAt)}</Row>
    </dl>
  );
}

function Links({ detail, baseUrl }: { detail: TicketDetail; baseUrl: string }) {
  const raw = (detail.issue.raw ?? {}) as Record<string, unknown>;
  const links = rawList(IssueLinkSchema, raw.issuelinks);
  const attachments = rawList(AttachmentSchema, raw.attachment);
  return (
    <div className="flex flex-col gap-6 text-sm">
      <section>
        <h3 className="mb-2 font-medium">Issue links</h3>
        {links.length === 0 && <p className="text-muted-foreground">No links.</p>}
        <ul className="flex flex-col gap-1">
          {links.map((l) => {
            const other = l.outwardIssue ?? l.inwardIssue;
            const verb = l.outwardIssue ? l.type.outward : l.type.inward;
            if (!other) return null;
            return (
              <li key={l.id} className="flex items-center gap-2">
                <span className="text-muted-foreground">{verb}</span>
                <button
                  type="button"
                  className="font-mono text-xs underline"
                  onClick={() => void openUrl(`${baseUrl}/browse/${other.key}`)}
                >
                  {other.key}
                </button>
                <span className="truncate">{other.fields?.summary}</span>
                {other.fields?.status && (
                  <StatusBadge
                    status={other.fields.status.name}
                    category={
                      (["new", "indeterminate", "done"].includes(
                        other.fields.status.statusCategory.key,
                      )
                        ? other.fields.status.statusCategory.key
                        : "new") as "new"
                    }
                  />
                )}
              </li>
            );
          })}
        </ul>
      </section>
      <section>
        <h3 className="mb-2 font-medium">Attachments</h3>
        {attachments.length === 0 && <p className="text-muted-foreground">No attachments.</p>}
        <ul className="flex flex-col gap-1">
          {attachments.map((a) => (
            <li key={a.id} className="flex items-center gap-2">
              <Paperclip className="size-3.5 text-muted-foreground" />
              {a.content ? (
                <button
                  type="button"
                  className="underline"
                  onClick={() => void openUrl(a.content ?? "")}
                >
                  {a.filename}
                </button>
              ) : (
                a.filename
              )}
              {a.size !== undefined && (
                <span className="text-muted-foreground">{Math.ceil(a.size / 1024)} KB</span>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export function TicketSheet({
  issueKey,
  onClose,
}: {
  issueKey: string | undefined;
  onClose: () => void;
}) {
  const { data: settings } = useSettings();
  const baseUrl = settings?.jira.baseUrl ?? "";
  const [editing, setEditing] = useState(false);
  const detail = useQuery({
    queryKey: queryKeys.ticketDetail(issueKey ?? ""),
    queryFn: ({ signal }) => run(ticketDetail(issueKey ?? ""), signal),
    enabled: !!issueKey,
  });
  useEffect(() => {
    if (issueKey) void run(markViewed(issueKey)).catch(() => undefined);
  }, [issueKey]);

  const d = detail.data;
  return (
    <Sheet open={!!issueKey} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full gap-0 sm:max-w-2xl">
        <SheetHeader className="border-b">
          <SheetDescription className="flex items-center gap-2 font-mono">
            {issueKey}
            {d?.issue.stale && <Badge variant="outline">No longer in sync scope</Badge>}
          </SheetDescription>
          <SheetTitle className="pr-8 text-lg leading-snug">
            {d?.issue.summary ?? <Skeleton className="h-6 w-3/4" />}
          </SheetTitle>
          {d && (
            <div className="flex flex-wrap items-center gap-2 pt-2">
              <TransitionSelect issue={d.issue} />
              <AssignButton issue={d.issue} />
              <EpicSelect issue={d.issue} />
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void openUrl(`${baseUrl}/browse/${d.issue.key}`)}
              >
                <ExternalLink /> Open in Jira
              </Button>
            </div>
          )}
        </SheetHeader>
        {detail.isError && (
          <p className="p-4 text-sm text-destructive">Could not load this ticket.</p>
        )}
        {d === null && (
          <p className="p-4 text-sm text-muted-foreground">
            This ticket is not in the local cache.
          </p>
        )}
        {d && (
          <Tabs defaultValue="details" className="min-h-0 flex-1 gap-0">
            <TabsList className="mx-4 mt-3 h-auto flex-wrap justify-start *:h-7 *:flex-none">
              <TabsTrigger value="details">Details</TabsTrigger>
              <TabsTrigger value="description">Description</TabsTrigger>
              <TabsTrigger value="comments">Comments ({d.comments.length})</TabsTrigger>
              <TabsTrigger value="waiting">Waiting on</TabsTrigger>
              <TabsTrigger value="links">Links</TabsTrigger>
              <TabsTrigger value="notes">Notes</TabsTrigger>
            </TabsList>
            <ScrollArea className="min-h-0 flex-1">
              <div className="p-4">
                <TabsContent value="details">
                  <Details detail={d} />
                </TabsContent>
                <TabsContent value="description">
                  {d.issue.descriptionHtml ? (
                    <JiraHtml html={d.issue.descriptionHtml} baseUrl={baseUrl} />
                  ) : d.issue.description ? (
                    <pre className="whitespace-pre-wrap text-sm">{d.issue.description}</pre>
                  ) : (
                    <p className="text-sm text-muted-foreground">No description.</p>
                  )}
                </TabsContent>
                <TabsContent value="comments" className="flex flex-col gap-4">
                  {d.comments.length === 0 && (
                    <p className="text-sm text-muted-foreground">No comments yet.</p>
                  )}
                  {d.comments.map((c) => (
                    <article key={c.id} className="rounded-lg border p-3">
                      <header className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">
                          {c.authorDisplay ?? c.author ?? "Unknown"}
                        </span>
                        <time dateTime={c.created} title={dateTime(c.created)}>
                          {relativeTime(c.created)}
                        </time>
                      </header>
                      {c.bodyHtml ? (
                        <JiraHtml html={c.bodyHtml} baseUrl={baseUrl} />
                      ) : (
                        <p className="whitespace-pre-wrap text-sm">{c.body}</p>
                      )}
                    </article>
                  ))}
                  <CommentComposer issue={d.issue} />
                </TabsContent>
                <TabsContent value="waiting">
                  <IssueDependencies issueKey={d.issue.key} />
                </TabsContent>
                <TabsContent value="links">
                  <Links detail={d} baseUrl={baseUrl} />
                </TabsContent>
                <TabsContent value="notes">
                  <ContextNotes subject={{ type: "issue", id: d.issue.key }} />
                </TabsContent>
              </div>
            </ScrollArea>
          </Tabs>
        )}
        {d && <EditDialog issue={d.issue} open={editing} onOpenChange={setEditing} />}
      </SheetContent>
    </Sheet>
  );
}

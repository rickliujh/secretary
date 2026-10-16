import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: 30_000 },
    mutations: { retry: false },
  },
});

export const queryKeys = {
  settings: ["settings"] as const,
  secretStatus: (name: string) => ["secret-status", name] as const,
  usage: ["llm-usage"] as const,
  recentCalls: ["llm-calls"] as const,
  dataPaths: ["data-paths"] as const,
  storage: ["storage"] as const,
  tickets: ["tickets"] as const,
  /** Under `tickets`, so a sync or a viewed ticket refreshes the order. */
  ticketPicker: ["tickets", "picker"] as const,
  ticketRows: ["tickets", "rows"] as const,
  /** Today (D49); under "tickets" so sync, decisions and dependency changes refresh it. */
  today: ["tickets", "today"] as const,
  /**
   * Sprint fit of a thread's new tickets and the user's sprint load (D57); under
   * "tickets", so sync and decisions (proposal edits included) refresh them.
   */
  sprintFit: (inboxItemId: string, settings: readonly unknown[], today: string) =>
    ["tickets", "sprint-fit", inboxItemId, ...settings, today] as const,
  sprintLoad: (settings: readonly unknown[], today: string) =>
    ["tickets", "sprint-load", ...settings, today] as const,
  /** An existing ticket joining an active sprint from its Edit dialog (D58). */
  ticketSprintFit: (
    issueKey: string,
    current: string | null,
    sprintId: number,
    points: number | null,
    settings: readonly unknown[],
    today: string,
  ) =>
    [
      "tickets",
      "ticket-sprint-fit",
      issueKey,
      current,
      sprintId,
      points,
      ...settings,
      today,
    ] as const,
  /** The sprint the Edit dialog's switch joins (D58); under "tickets" like the fits. */
  ticketJoinSprint: (projectKey: string, settings: readonly unknown[], today: string) =>
    ["tickets", "ticket-join-sprint", projectKey, ...settings, today] as const,
  /** Teams on synced tickets, for the Edit dialog's Team field (D59); sync refreshes them. */
  syncedTeams: ["tickets", "synced-teams"] as const,
  /** Jira's team suggestions for typed text (D59). */
  teamSearch: (fieldId: string, text: string) => ["jira", "team-search", fieldId, text] as const,
  /** The synced sprints, for the Edit dialog's Sprint select (D58); sync refreshes them. */
  knownSprints: ["tickets", "known-sprints"] as const,
  /** Sprint > Epics (D50); under "tickets" like Today. */
  epicHealth: ["tickets", "epic-health"] as const,
  /** When the sweep's weekly pass over untouched asks last ran (D49). */
  sweepStale: ["sweep", "stale"] as const,
  ticketSearch: (q: string) => ["tickets", "search", q] as const,
  ticketDetail: (key: string) => ["tickets", "detail", key] as const,
  transitions: (key: string) => ["tickets", "transitions", key] as const,
  /** Transitions into a done status (D49), read when Done is pressed. */
  doneTransitions: (key: string) => ["tickets", "done-transitions", key] as const,
  epics: (project: string) => ["tickets", "epics", project] as const,
  priorities: ["jira", "priorities"] as const,
  fieldInfo: ["jira", "fields"] as const,
  directory: ["directory"] as const,
  teams: ["directory", "teams"] as const,
  people: ["directory", "people"] as const,
  team: (id: string) => ["directory", "team", id] as const,
  person: (id: string) => ["directory", "person", id] as const,
  notes: (type: string, id: string) => ["directory", "notes", type, id] as const,
  jiraUserSuggestions: ["directory", "jira-suggestions"] as const,
  contactsByUsername: ["directory", "by-username"] as const,
  confluenceSearch: (cql: string) => ["confluence", "search", cql] as const,
  inbox: ["inbox"] as const,
  inboxList: (search: string) => ["inbox", "list", search] as const,
  inboxDetail: (id: string) => ["inbox", "detail", id] as const,
  pendingCount: ["inbox", "pending"] as const,
  dependencies: ["dependencies"] as const,
  dependencyList: (includeResolved: boolean, issueKey?: string) =>
    ["dependencies", "list", includeResolved, issueKey ?? ""] as const,
  dependency: (id: string) => ["dependencies", "detail", id] as const,
  memories: ["memories"] as const,
  chats: ["chats"] as const,
  chat: (id: string) => ["chats", id] as const,
  drafts: ["drafts"] as const,
  draftList: ["drafts", "list"] as const,
  draft: (id: string) => ["drafts", "detail", id] as const,
  startup: ["startup"] as const,
  jiraUsername: ["jira", "username"] as const,
  assignableUsers: (key: string, q: string) => ["jira", "assignable", key, q] as const,
  planning: ["planning"] as const,
  planPrep: ["planning", "prep"] as const,
  /** Obsidian vault names and source checks (D41). */
  sources: ["sources"] as const,
  /** The last recap report (D37). */
  report: ["report"] as const,
};

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
  /** Under "tickets" so sync, decisions and dependency changes refresh it. */
  dashboard: ["tickets", "dashboard"] as const,
  ticketSearch: (q: string) => ["tickets", "search", q] as const,
  ticketDetail: (key: string) => ["tickets", "detail", key] as const,
  transitions: (key: string) => ["tickets", "transitions", key] as const,
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
  /** The last recap report (D37). */
  report: ["report"] as const,
};

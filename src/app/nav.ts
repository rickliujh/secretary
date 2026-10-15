import {
  Brain,
  Building2,
  CalendarCheck,
  CalendarRange,
  ChartNoAxesColumn,
  Hourglass,
  Inbox,
  ListTree,
  type LucideIcon,
  MessagesSquare,
  NotebookPen,
  PenLine,
  Settings,
  Sunrise,
  UserRound,
  Users,
} from "lucide-react";
import { CONTEXT_TABS, type ContextTab, SPRINT_TABS, type SprintTab } from "./tabs";

export type NavItem = {
  to:
    | "/"
    | "/inbox"
    | "/tickets"
    | "/waiting"
    | "/sprint"
    | "/drafts"
    | "/chat"
    | "/context"
    | "/settings";
  label: string;
  icon: LucideIcon;
};

/** The pages in the sidebar (D50; Drafts came back on 2026-10-15). */
export const MAIN_NAV: NavItem[] = [
  { to: "/", label: "Today", icon: Sunrise },
  { to: "/inbox", label: "Inbox", icon: Inbox },
  { to: "/tickets", label: "Tickets", icon: ListTree },
  { to: "/waiting", label: "Waiting on", icon: Hourglass },
  { to: "/sprint", label: "Sprint", icon: CalendarRange },
  { to: "/drafts", label: "Drafts", icon: PenLine },
  { to: "/chat", label: "Chat", icon: MessagesSquare },
  { to: "/context", label: "Context", icon: Users },
];

export const SETTINGS_NAV: NavItem = { to: "/settings", label: "Settings", icon: Settings };

/** Every page, for the header title and the command palette. */
export const ALL_PAGES = [...MAIN_NAV, SETTINGS_NAV];

export type PageTab = {
  label: string;
  page: "Sprint" | "Context";
  icon: LucideIcon;
  link:
    | { to: "/sprint"; search: { tab: SprintTab } }
    | { to: "/context"; search: { tab: ContextTab } };
};

const TAB_ICONS: Record<SprintTab | ContextTab, LucideIcon> = {
  plan: CalendarCheck,
  report: NotebookPen,
  epics: ChartNoAxesColumn,
  people: UserRound,
  teams: Building2,
  memory: Brain,
};

/** The tabs of Sprint and Context, for the command palette ("Report" still finds the recap). */
export const PAGE_TABS: PageTab[] = [
  ...SPRINT_TABS.map((t) => ({
    label: t.label,
    page: "Sprint" as const,
    icon: TAB_ICONS[t.value],
    link: { to: "/sprint" as const, search: { tab: t.value } },
  })),
  ...CONTEXT_TABS.map((t) => ({
    label: t.label,
    page: "Context" as const,
    icon: TAB_ICONS[t.value],
    link: { to: "/context" as const, search: { tab: t.value } },
  })),
];

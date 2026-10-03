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

/** The seven pages in the sidebar (D50). */
export const MAIN_NAV: NavItem[] = [
  { to: "/", label: "Today", icon: Sunrise },
  { to: "/inbox", label: "Inbox", icon: Inbox },
  { to: "/tickets", label: "Tickets", icon: ListTree },
  { to: "/waiting", label: "Waiting on", icon: Hourglass },
  { to: "/sprint", label: "Sprint", icon: CalendarRange },
  { to: "/chat", label: "Chat", icon: MessagesSquare },
  { to: "/context", label: "Context", icon: Users },
];

/** Out of the sidebar unless `general.draftsInSidebar` is on; drafts open as a panel. */
export const DRAFTS_NAV: NavItem = { to: "/drafts", label: "Drafts", icon: PenLine };

export const SETTINGS_NAV: NavItem = { to: "/settings", label: "Settings", icon: Settings };

/** The sidebar's pages: Drafts goes back before Chat when the setting asks for it. */
export function sidebarNav(draftsInSidebar: boolean): NavItem[] {
  if (!draftsInSidebar) return MAIN_NAV;
  const chat = MAIN_NAV.findIndex((n) => n.to === "/chat");
  return [...MAIN_NAV.slice(0, chat), DRAFTS_NAV, ...MAIN_NAV.slice(chat)];
}

/** Every page, for the header title and the command palette, whatever the sidebar shows. */
export const ALL_PAGES = [...MAIN_NAV, DRAFTS_NAV, SETTINGS_NAV];

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

import {
  Brain,
  Building2,
  CalendarRange,
  Hourglass,
  Inbox,
  LayoutDashboard,
  ListTree,
  type LucideIcon,
  MessagesSquare,
  NotebookPen,
  PenLine,
  Settings,
  Users,
} from "lucide-react";

export type NavItem = {
  to:
    | "/"
    | "/inbox"
    | "/tickets"
    | "/waiting"
    | "/planning"
    | "/report"
    | "/people"
    | "/teams"
    | "/drafts"
    | "/memory"
    | "/chat"
    | "/settings";
  label: string;
  icon: LucideIcon;
};

export const WORK_NAV: NavItem[] = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/inbox", label: "Inbox", icon: Inbox },
  { to: "/tickets", label: "Tickets", icon: ListTree },
  { to: "/waiting", label: "Waiting on", icon: Hourglass },
  { to: "/planning", label: "Planning", icon: CalendarRange },
  { to: "/report", label: "Report", icon: NotebookPen },
  { to: "/drafts", label: "Drafts", icon: PenLine },
  { to: "/chat", label: "Chat", icon: MessagesSquare },
];

export const CONTEXT_NAV: NavItem[] = [
  { to: "/people", label: "People", icon: Users },
  { to: "/teams", label: "Teams", icon: Building2 },
  { to: "/memory", label: "Memory", icon: Brain },
];

export const SETTINGS_NAV: NavItem = { to: "/settings", label: "Settings", icon: Settings };

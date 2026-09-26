import { Link, useRouterState } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { CONTEXT_NAV, type NavItem, SETTINGS_NAV, WORK_NAV } from "@/app/nav";
import { macOverlay } from "@/app/platform";
import { usePendingCount } from "@/app/queries";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";

function NavList({
  items,
  pathname,
  badges = {},
}: {
  items: NavItem[];
  pathname: string;
  badges?: Record<string, number>;
}) {
  return (
    <SidebarMenu>
      {items.map((item) => (
        <SidebarMenuItem key={item.to}>
          <SidebarMenuButton asChild isActive={pathname === item.to} tooltip={item.label}>
            <Link to={item.to}>
              <item.icon />
              <span>{item.label}</span>
            </Link>
          </SidebarMenuButton>
          {(badges[item.to] ?? 0) > 0 && <SidebarMenuBadge>{badges[item.to]}</SidebarMenuBadge>}
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}

export function AppSidebar() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const pending = usePendingCount({
    refetchInterval: 30_000,
  });
  return (
    <Sidebar collapsible="icon">
      {/* macOS draws its traffic lights here (D36); the strip also drags the window. */}
      {macOverlay && <div data-tauri-drag-region className="h-8 shrink-0" />}
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/">
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
                  <Sparkles className="size-4" />
                </div>
                <span className="font-semibold">Secretary</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Work</SidebarGroupLabel>
          <SidebarGroupContent>
            <NavList
              items={WORK_NAV}
              pathname={pathname}
              badges={{ "/inbox": pending.data ?? 0 }}
            />
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Context</SidebarGroupLabel>
          <SidebarGroupContent>
            <NavList items={CONTEXT_NAV} pathname={pathname} />
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <NavList items={[SETTINGS_NAV]} pathname={pathname} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

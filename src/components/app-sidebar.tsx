import { Link, useRouterState } from "@tanstack/react-router";
import { useSettings } from "@/app/hooks";
import { type NavItem, SETTINGS_NAV, sidebarNav } from "@/app/nav";
import { macOverlay } from "@/app/platform";
import { usePendingCount } from "@/app/queries";
import logo from "@/assets/logo.svg";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
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
  const settings = useSettings();
  return (
    <Sidebar collapsible="icon">
      {/* macOS draws its traffic lights here (D36); the strip also drags the window. */}
      {macOverlay && <div data-tauri-drag-region className="h-8 shrink-0" />}
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <Link to="/">
                <img src={logo} alt="" className="size-8 shrink-0 rounded-lg" />
                <span className="font-semibold">Secretary</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <NavList
              items={sidebarNav(settings.data?.general.draftsInSidebar ?? false)}
              pathname={pathname}
              badges={{ "/inbox": pending.data ?? 0 }}
            />
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

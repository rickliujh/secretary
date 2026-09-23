import { createRootRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useState } from "react";
import { CONTEXT_NAV, SETTINGS_NAV, WORK_NAV } from "@/app/nav";
import { AppSidebar } from "@/components/app-sidebar";
import { CommandPalette } from "@/components/command-palette";
import { StartupGate } from "@/components/startup-gate";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { UsageIndicator } from "@/components/usage-indicator";

export const Route = createRootRoute({ component: RootLayout });

const ALL_NAV = [...WORK_NAV, ...CONTEXT_NAV, SETTINGS_NAV];

function RootLayout() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const title = ALL_NAV.find((n) => n.to === pathname)?.label ?? "Secretary";
  return (
    <StartupGate>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <header className="flex h-12 shrink-0 items-center gap-2 border-b px-3">
            <SidebarTrigger />
            <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4" />
            <span className="text-sm font-medium">{title}</span>
            <div className="ml-auto flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="text-muted-foreground"
                onClick={() => setPaletteOpen(true)}
              >
                <Search />
                Search
                <kbd className="ml-2 rounded border px-1 font-mono text-[10px]">Ctrl K</kbd>
              </Button>
              <UsageIndicator />
              <ThemeToggle />
            </div>
          </header>
          <main className="flex-1 overflow-auto p-6">
            <Outlet />
          </main>
        </SidebarInset>
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      </SidebarProvider>
    </StartupGate>
  );
}

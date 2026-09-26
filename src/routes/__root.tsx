import { createRootRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { CONTEXT_NAV, SETTINGS_NAV, WORK_NAV } from "@/app/nav";
import { useFollowupReminders } from "@/app/reminders";
import { useSyncScheduler } from "@/app/sync";
import { AppSidebar } from "@/components/app-sidebar";
import { CommandPalette } from "@/components/command-palette";
import { StartupGate } from "@/components/startup-gate";
import { SyncIndicator } from "@/components/sync-indicator";
import { ThemeToggle } from "@/components/theme-toggle";
import { useTicketPanel } from "@/components/tickets/ticket-link";
import { TicketSheet } from "@/components/tickets/ticket-sheet";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { UsageIndicator } from "@/components/usage-indicator";

export const Route = createRootRoute({
  // `ticket` opens the ticket panel over whatever page is showing.
  validateSearch: z.object({ ticket: z.string().optional() }),
  component: RootLayout,
});

const ALL_NAV = [...WORK_NAV, ...CONTEXT_NAV, SETTINGS_NAV];

/** Hooks that need the database, so they run inside the startup gate. */
function Background() {
  useSyncScheduler();
  useFollowupReminders();
  return null;
}

function RootLayout() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { ticket } = Route.useSearch();
  const openTicket = useTicketPanel();
  const title = ALL_NAV.find((n) => n.to === pathname)?.label ?? "Secretary";
  return (
    <StartupGate>
      <Background />
      {/* Fixed viewport height so pages scroll inside the content area; the
          ticket table relies on a bounded scroll container for virtualisation. */}
      <SidebarProvider className="h-svh">
        <AppSidebar />
        <SidebarInset className="min-h-0 overflow-hidden">
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
              <SyncIndicator />
              <UsageIndicator />
              <ThemeToggle />
            </div>
          </header>
          <div className="min-h-0 flex-1 overflow-auto p-6">
            <Outlet />
          </div>
        </SidebarInset>
        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
        <TicketSheet issueKey={ticket} onClose={() => openTicket(null)} />
      </SidebarProvider>
    </StartupGate>
  );
}

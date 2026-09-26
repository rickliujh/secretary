import { createRootRoute, Outlet, useRouterState } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import { useDeleteWordKey } from "@/app/keyboard";
import { CONTEXT_NAV, SETTINGS_NAV, WORK_NAV } from "@/app/nav";
import { macOverlay, ownWindowButtons } from "@/app/platform";
import { useFollowupReminders } from "@/app/reminders";
import { useAutoCleanup, useStorageWarning } from "@/app/storage";
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
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar";
import { UsageIndicator } from "@/components/usage-indicator";
import { WindowControls } from "@/components/window-controls";
import { cn } from "@/lib/utils";

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
  useAutoCleanup();
  useDeleteWordKey();
  useStorageWarning();
  return null;
}

/** The app header doubles as the title bar: it drags the window (D36). */
function AppHeader({ title, onSearch }: { title: string; onSearch: () => void }) {
  const { state } = useSidebar();
  return (
    <header
      data-tauri-drag-region
      className={cn(
        "flex h-12 shrink-0 items-center gap-2 border-b px-3",
        // The traffic lights sit over the collapsed sidebar and the start of the header.
        macOverlay && state === "collapsed" && "pl-10",
        ownWindowButtons && "pr-1",
      )}
    >
      <SidebarTrigger />
      <Separator orientation="vertical" className="mx-1 data-[orientation=vertical]:h-4" />
      <span data-tauri-drag-region className="text-sm font-medium">
        {title}
      </span>
      <div data-tauri-drag-region className="ml-auto flex items-center gap-2">
        <Button variant="outline" size="sm" className="text-muted-foreground" onClick={onSearch}>
          <Search />
          Search
          <kbd className="ml-2 rounded border px-1 font-mono text-[10px]">Ctrl K</kbd>
        </Button>
        <SyncIndicator />
        <UsageIndicator />
        <ThemeToggle />
        <WindowControls className="ml-1" />
      </div>
    </header>
  );
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
          <AppHeader title={title} onSearch={() => setPaletteOpen(true)} />
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

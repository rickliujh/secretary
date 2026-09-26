import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X } from "lucide-react";
import { inTauri, ownWindowButtons } from "@/app/platform";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Minimise, maximise and close for Windows and Linux, where the native title bar
 * is off (D36). macOS keeps its own traffic lights.
 */
export function WindowControls({ className }: { className?: string }) {
  if (!ownWindowButtons) return null;
  const win = getCurrentWindow();
  return (
    <div className={cn("flex items-center", className)}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Minimise"
        onClick={() => void win.minimize()}
      >
        <Minus />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Maximise"
        onClick={() => void win.toggleMaximize()}
      >
        <Square className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Close"
        className="hover:bg-destructive hover:text-white"
        onClick={() => void win.close()}
      >
        <X />
      </Button>
    </div>
  );
}

/** A draggable strip with the window buttons, for screens without the app header. */
export function WindowBar() {
  if (!inTauri) return null;
  return (
    <div data-tauri-drag-region className="fixed inset-x-0 top-0 z-50 flex h-12 justify-end px-2">
      <WindowControls />
    </div>
  );
}

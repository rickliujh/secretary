/**
 * The draft composer as a panel (D50): a Sheet over whatever page is open. Open
 * it with `useDraftPanel()`; the Drafts page still lists every draft.
 */
import { Link, useRouterState } from "@tanstack/react-router";
import { List } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { DraftComposer } from "./draft-composer";
import { DraftEditor } from "./draft-editor";
import { type DraftPanel, DraftPanelContext, type DraftPanelTarget } from "./use-draft-panel";

/** Holds the panel for the whole app; mounted once in the root layout. */
export function DraftPanelProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<DraftPanelTarget | null>(null);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // A link inside the panel to another page (a dependency, a contact) closes it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on page change only.
  useEffect(() => setTarget(null), [pathname]);
  const panel = useMemo<DraftPanel>(() => ({ open: setTarget, close: () => setTarget(null) }), []);
  return (
    <DraftPanelContext.Provider value={panel}>
      {children}
      <DraftSheet target={target} onTarget={setTarget} onClose={panel.close} />
    </DraftPanelContext.Provider>
  );
}

function DraftSheet({
  target,
  onTarget,
  onClose,
}: {
  target: DraftPanelTarget | null;
  onTarget: (t: DraftPanelTarget) => void;
  onClose: () => void;
}) {
  const draftId = target && "draftId" in target ? target.draftId : null;
  return (
    <Sheet open={!!target} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full gap-0 sm:max-w-2xl">
        <SheetHeader className="border-b">
          <SheetDescription>
            {draftId
              ? "Edit it, copy it or open it in Teams or your mail app; you send it yourself."
              : "A short and a standard version in the recipient's style. You send it yourself."}
          </SheetDescription>
          <SheetTitle className="text-lg">{draftId ? "Draft" : "New draft"}</SheetTitle>
          <div className="pt-2">
            <Button asChild variant="outline" size="sm">
              <Link to="/drafts" search={draftId ? { id: draftId } : {}} onClick={onClose}>
                <List /> All drafts
              </Link>
            </Button>
          </div>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {target &&
            ("draftId" in target ? (
              <DraftEditor
                key={target.draftId}
                id={target.draftId}
                write={!!target.write}
                onDeleted={onClose}
              />
            ) : (
              <DraftComposer
                // Another prefill while open starts a fresh form.
                key={JSON.stringify(target.prefill)}
                prefill={target.prefill}
                onCreated={(id) => onTarget({ draftId: id, write: true })}
              />
            ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}

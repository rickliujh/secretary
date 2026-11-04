/**
 * Cards a run is revising (D68): while their item is read again, their decide
 * buttons wait, so an approval never races the revision that replaces them.
 */
import { createContext, type ReactNode, useContext } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const RunLockContext = createContext<ReadonlySet<string>>(new Set());

/** The proposals of the items under revision, for the cards below it. */
export const RunLockProvider = RunLockContext.Provider;

/** True when any of these proposals is under revision. */
export function useRunLocked(...ids: readonly string[]): boolean {
  const locked = useContext(RunLockContext);
  return ids.some((id) => locked.has(id));
}

export const LOCKED_HINT = "Wait for the run";

/** A disabled button says why on hover. */
export function LockHint({ locked, children }: { locked: boolean; children: ReactNode }) {
  if (!locked) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A disabled button gets no pointer events; the wrapper takes the hover. */}
        <span className="inline-flex">{children}</span>
      </TooltipTrigger>
      <TooltipContent>{LOCKED_HINT}</TooltipContent>
    </Tooltip>
  );
}

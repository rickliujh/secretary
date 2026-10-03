/**
 * Opening the draft panel (D50) from anywhere: a ticket, a dependency's chase, a
 * person, a team, the command palette, and later the Today rows. The panel itself
 * is `DraftPanelProvider` in `draft-panel.tsx`, mounted once in the root layout.
 */
import { createContext, useContext } from "react";
import type { DRAFT_CHANNELS } from "@/services/comms";
import type { MESSAGE_INTENTS } from "@/services/proposals/schema";

/** What a new draft starts with; anything left out keeps the composer's default. */
export type DraftPrefill = {
  recipient?: { type: "person" | "team"; id: string };
  kind?: (typeof DRAFT_CHANNELS)[number];
  intent?: (typeof MESSAGE_INTENTS)[number];
  issueKeys?: string[];
  /** A dependency from Waiting on; its ticket and owner fill in as when picked in the form. */
  dependencyId?: string;
  notes?: string;
};

/** A new draft (with an optional prefill), or an existing one; `write` writes it on open. */
export type DraftPanelTarget = { prefill: DraftPrefill } | { draftId: string; write?: boolean };

export type DraftPanel = {
  open: (target: DraftPanelTarget) => void;
  close: () => void;
};

export const DraftPanelContext = createContext<DraftPanel | null>(null);

/**
 * `open({ prefill: { recipient: { type: "person", id } } })` starts a new draft;
 * `open({ draftId, write: true })` shows one that exists and writes it if empty.
 */
export function useDraftPanel(): DraftPanel {
  const panel = useContext(DraftPanelContext);
  if (!panel) throw new Error("useDraftPanel needs DraftPanelProvider (in the root layout)");
  return panel;
}

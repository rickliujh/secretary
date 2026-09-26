/** Display names for service enums, shared by every page that shows them. */
import type { DRAFT_CHANNELS } from "@/services/comms";
import type { Source } from "@/services/intake";
import type { MESSAGE_INTENTS } from "@/services/proposals/schema";

type MessageIntent = (typeof MESSAGE_INTENTS)[number];
type DraftChannel = (typeof DRAFT_CHANNELS)[number];

export const INTENT_LABELS: Record<MessageIntent, string> = {
  chase: "Chase",
  status_update: "Status update",
  request: "Request",
  escalation: "Escalation",
  fyi: "FYI",
  thank_you: "Thank you",
};

export const SOURCE_LABELS: Record<Source, string> = {
  teams: "Teams",
  email: "Email",
  meeting: "Meeting notes",
  typed: "Typed",
  other: "Other",
};

export const CHANNEL_LABELS: Record<DraftChannel, string> = {
  teams: "Teams",
  email: "Email",
};

/** For values stored as plain text: the label when known, else the value itself. */
function labelFor<K extends string>(labels: Record<K, string>) {
  const table: Readonly<Partial<Record<string, string>>> = labels;
  return (value: string) => (Object.hasOwn(table, value) ? table[value] : undefined) ?? value;
}

export const intentLabel = labelFor(INTENT_LABELS);
export const sourceLabel = labelFor(SOURCE_LABELS);

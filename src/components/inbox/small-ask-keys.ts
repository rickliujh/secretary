/**
 * Query keys for the small-asks home (D44). Under "inbox" so decisions refresh
 * them; kept here rather than in the shared key list to stay self-contained.
 */
export const SMALL_ASK_KEYS = {
  home: ["inbox", "small-ask-home"] as const,
  projects: ["tickets", "small-ask-projects"] as const,
};

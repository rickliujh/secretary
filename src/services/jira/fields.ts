/** Discovery of the Jira Software custom fields the app needs (FR-1.4, D30). */
import type { JiraField } from "./schemas";

export type FieldIds = {
  epicLink?: string;
  epicName?: string;
  sprint?: string;
  /** Story Points (Data Center) or Story point estimate (Cloud), D30. */
  storyPoints?: string;
};

const FIELD_KEYS = [
  "epicLink",
  "epicName",
  "sprint",
  "storyPoints",
] as const satisfies readonly (keyof FieldIds)[];

const CUSTOM_TYPES: Record<Exclude<keyof FieldIds, "storyPoints">, string> = {
  epicLink: "com.pyxis.greenhopper.jira:gh-epic-link",
  epicName: "com.pyxis.greenhopper.jira:gh-epic-label",
  sprint: "com.pyxis.greenhopper.jira:gh-sprint",
};

/** Cloud's "Story point estimate" field type. */
const STORY_POINTS_TYPE = "com.pyxis.greenhopper.jira:jsw-story-points";
/** Names used for story points: Data Center, then Cloud's two variants. */
const STORY_POINTS_NAMES = ["story points", "story point estimate"];

/**
 * Story points have no Jira Software type on Data Center (it is a plain number
 * field), so: Cloud's exact custom type first, then a number field with a known
 * name, then any field with a known name.
 */
function discoverStoryPoints(fields: readonly JiraField[]): string | undefined {
  const byType = fields.find((f) => f.schema?.custom === STORY_POINTS_TYPE);
  if (byType) return byType.id;
  const named = fields.filter((f) => STORY_POINTS_NAMES.includes(f.name.trim().toLowerCase()));
  return (named.find((f) => f.schema?.type === "number") ?? named[0])?.id;
}

export function discoverFieldIds(fields: readonly JiraField[]): FieldIds {
  const out: FieldIds = {};
  for (const [name, type] of Object.entries(CUSTOM_TYPES) as [
    keyof typeof CUSTOM_TYPES,
    string,
  ][]) {
    const match = fields.find((f) => f.schema?.custom === type);
    if (match) out[name] = match.id;
  }
  const storyPoints = discoverStoryPoints(fields);
  if (storyPoints) out.storyPoints = storyPoints;
  return out;
}

/** Manual overrides from settings win over discovered ids. */
export function effectiveFieldIds(discovered: FieldIds, overrides: FieldIds): FieldIds {
  const out: FieldIds = {};
  for (const k of FIELD_KEYS) out[k] = overrides[k]?.trim() || discovered[k];
  return out;
}

/** `customfield_10100` -> `cf[10100]` for use in JQL. */
export function jqlFieldRef(fieldId: string): string {
  const m = /^customfield_(\d+)$/.exec(fieldId);
  return m ? `cf[${m[1]}]` : fieldId;
}

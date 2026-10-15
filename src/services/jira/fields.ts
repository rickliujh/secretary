/** Discovery of the Jira Software custom fields the app needs (FR-1.4, D30). */
import type { JiraField } from "./schemas";

export type FieldIds = {
  epicLink?: string;
  epicName?: string;
  sprint?: string;
  /** Story Points (Data Center) or Story point estimate (Cloud), D30. */
  storyPoints?: string;
  /**
   * Further story point fields found by discovery. Cloud sites often have both
   * "Story point estimate" and "Story Points", and projects use either; per issue
   * the first field with a value wins (D35). Not used when `storyPoints` is set
   * by hand.
   */
  storyPointsAlt?: string[];
};

const FIELD_KEYS = [
  "epicLink",
  "epicName",
  "sprint",
  "storyPoints",
] as const satisfies readonly (keyof FieldIds)[];

const CUSTOM_TYPES: Record<Exclude<keyof FieldIds, "storyPoints" | "storyPointsAlt">, string> = {
  epicLink: "com.pyxis.greenhopper.jira:gh-epic-link",
  epicName: "com.pyxis.greenhopper.jira:gh-epic-label",
  sprint: "com.pyxis.greenhopper.jira:gh-sprint",
};

/** Cloud's "Story point estimate" field type. */
const STORY_POINTS_TYPE = "com.pyxis.greenhopper.jira:jsw-story-points";
/** Names used for story points: Data Center, then Cloud's two variants. */
const STORY_POINTS_NAMES = ["story points", "story point estimate"];

/**
 * Every story point field, most likely first. Story points have no Jira Software
 * type on Data Center (it is a plain number field), so: Cloud's exact custom type,
 * then number fields with a known name, then any field with a known name.
 */
function discoverStoryPoints(fields: readonly JiraField[]): string[] {
  const named = fields.filter((f) => STORY_POINTS_NAMES.includes(f.name.trim().toLowerCase()));
  const ordered = [
    ...fields.filter((f) => f.schema?.custom === STORY_POINTS_TYPE),
    ...named.filter((f) => f.schema?.type === "number"),
    ...named,
  ];
  return [...new Set(ordered.map((f) => f.id))];
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
  const [storyPoints, ...alt] = discoverStoryPoints(fields);
  if (storyPoints) out.storyPoints = storyPoints;
  if (alt.length) out.storyPointsAlt = alt;
  return out;
}

/** Manual overrides from settings win over discovered ids. */
export function effectiveFieldIds(discovered: FieldIds, overrides: FieldIds): FieldIds {
  const out: FieldIds = {};
  for (const k of FIELD_KEYS) out[k] = overrides[k]?.trim() || discovered[k];
  if (!overrides.storyPoints?.trim() && discovered.storyPointsAlt?.length)
    out.storyPointsAlt = discovered.storyPointsAlt;
  return out;
}

/** The story point fields to read, in order; the first with a value wins. */
export const storyPointFields = (ids: FieldIds): string[] =>
  [ids.storyPoints, ...(ids.storyPointsAlt ?? [])].filter((f): f is string => !!f);

/**
 * The story point field to write (D55): the first effective story point field
 * that is on the screen (create metadata for a new issue, edit metadata for an
 * existing one), or null when the screen has none. Cloud sites may have both
 * "Story point estimate" and "Story Points", and a project shows only one.
 */
export function pointsFieldOn(ids: FieldIds, onScreen: Iterable<string>): string | null {
  const screen = new Set(onScreen);
  return storyPointFields(ids).find((f) => screen.has(f)) ?? null;
}

/**
 * The story point field to write on an existing issue (D55): of the effective
 * story point fields on its edit screen, the first that holds a value, so the
 * write lands where the board reads the points (D35); else the first on the
 * screen. Null when the screen has none.
 */
export function pointsFieldForIssue(
  ids: FieldIds,
  onScreen: Iterable<string>,
  issueFields: Readonly<Record<string, unknown>>,
): string | null {
  const screen = new Set(onScreen);
  const candidates = storyPointFields(ids).filter((f) => screen.has(f));
  return candidates.find((f) => typeof issueFields[f] === "number") ?? candidates[0] ?? null;
}

/** `customfield_10100` -> `cf[10100]` for use in JQL. */
export function jqlFieldRef(fieldId: string): string {
  const m = /^customfield_(\d+)$/.exec(fieldId);
  return m ? `cf[${m[1]}]` : fieldId;
}

/** Discovery of the Jira Software custom fields the app needs (FR-1.4). */
import type { JiraField } from "./schemas";

export type FieldIds = { epicLink?: string; epicName?: string; sprint?: string };

const CUSTOM_TYPES: Record<keyof FieldIds, string> = {
  epicLink: "com.pyxis.greenhopper.jira:gh-epic-link",
  epicName: "com.pyxis.greenhopper.jira:gh-epic-label",
  sprint: "com.pyxis.greenhopper.jira:gh-sprint",
};

export function discoverFieldIds(fields: readonly JiraField[]): FieldIds {
  const out: FieldIds = {};
  for (const [name, type] of Object.entries(CUSTOM_TYPES) as [keyof FieldIds, string][]) {
    const match = fields.find((f) => f.schema?.custom === type);
    if (match) out[name] = match.id;
  }
  return out;
}

/** Manual overrides from settings win over discovered ids. */
export function effectiveFieldIds(discovered: FieldIds, overrides: FieldIds): FieldIds {
  const pick = (k: keyof FieldIds) => overrides[k]?.trim() || discovered[k];
  return { epicLink: pick("epicLink"), epicName: pick("epicName"), sprint: pick("sprint") };
}

/** `customfield_10100` -> `cf[10100]` for use in JQL. */
export function jqlFieldRef(fieldId: string): string {
  const m = /^customfield_(\d+)$/.exec(fieldId);
  return m ? `cf[${m[1]}]` : fieldId;
}

/** Which vault files stay out of the index (design.md D41). Pure. */

/** "Private/", "/Private", "./Private" and "private" all name the same folder. */
export function normalizeExclude(entry: string): string {
  return entry
    .trim()
    .replaceAll("\\", "/")
    .replace(/^(\.\/)+/, "")
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
}

/**
 * True when `path` (vault-relative, forward slashes) is in a dot folder or is a
 * dot file anywhere in the tree, or when an entry of `exclude` names it or one
 * of its folders. Entries compare case-insensitively and ignore outer slashes.
 */
export function isExcluded(path: string, exclude: readonly string[]): boolean {
  if (path.split("/").some((seg) => seg.startsWith("."))) return true;
  const p = path.toLowerCase();
  return exclude.some((raw) => {
    const e = normalizeExclude(raw);
    return e !== "" && (p === e || p.startsWith(`${e}/`));
  });
}

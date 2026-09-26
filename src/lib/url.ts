/** A base URL without surrounding spaces or trailing slashes, ready to join with a path. */
export const trimBaseUrl = (url: string) => url.trim().replace(/\/+$/, "");

/** The parsed URL, or null when `url` is empty or not a URL. */
export const parseUrl = (url: string | null | undefined): URL | null => {
  if (!url) return null;
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

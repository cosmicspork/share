import { MAX_PATH_LENGTH } from "./limits";

/**
 * Validate a bundle-relative file path such as `css/app.css`. Returns the path
 * unchanged when it is acceptable and null otherwise. Nothing is rewritten: a
 * path that needs fixing is rejected instead.
 */
export function normalizePath(path: string): string | null {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) return null;
  if (path.startsWith("/")) return null;
  // Backslashes, NUL and other control characters.
  if (/[\\\u0000-\u001f\u007f]/.test(path)) return null;
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") return null;
  }
  return path;
}

/**
 * Turn the percent-encoded remainder of a URL path into a validated bundle
 * path. Each segment is decoded on its own, so an encoded slash (`%2F`) can
 * never introduce a new segment.
 */
export function decodeUrlPath(encoded: string): string | null {
  const segments: string[] = [];
  for (const raw of encoded.split("/")) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (segment.includes("/")) return null;
    segments.push(segment);
  }
  return normalizePath(segments.join("/"));
}

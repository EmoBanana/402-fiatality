/** Endpoint matching for the paywall: method + path pattern with `:param` segments. */
import type { EndpointRow } from "../db/dto";

/** Literal endpoint segments are limited to these characters, so they only ever match unencoded text. */
export const ENDPOINT_PATH_PATTERN = /^\/$|^(?:\/(?::[A-Za-z_][A-Za-z0-9_]*|(?!\.{1,2}(?:\/|$))[A-Za-z0-9._~-]+))+$/;

/** Split "/v1/products/abc?x=1" into its path and query parts. */
export function splitPathAndQuery(pathWithQuery: string): { path: string; query: string } {
  const i = pathWithQuery.indexOf("?");
  return i === -1 ? { path: pathWithQuery, query: "" } : { path: pathWithQuery.slice(0, i), query: pathWithQuery.slice(i) };
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * A request path we are willing to forward: absolute, no backslashes, no empty or dot segments (raw or
 * percent-encoded), no encoded slashes. Prevents escaping the seller's base path.
 */
export function isForwardablePath(path: string): boolean {
  if (!path.startsWith("/") || path.includes("\\")) return false;
  if (path === "/") return true;
  const segments = path.slice(1).split("/");
  return segments.every((segment, i) => {
    if (segment === "") return i === segments.length - 1; // a trailing slash is fine, "//" is not
    const decoded = decodeSegment(segment);
    return decoded !== null && decoded !== "." && decoded !== ".." && !decoded.includes("/") && !decoded.includes("\\");
  });
}

/** Best match for (method, path): exact literal segments beat `:param` segments. */
export function matchEndpoint(endpoints: EndpointRow[], method: string, path: string): EndpointRow | null {
  const segments = path.split("/");
  let best: EndpointRow | null = null;
  let bestScore = -1;
  for (const endpoint of endpoints) {
    if (endpoint.method !== method) continue;
    const pattern = endpoint.path.split("/");
    if (pattern.length !== segments.length) continue;
    let score = 0;
    let ok = true;
    for (let i = 0; i < pattern.length && ok; i++) {
      const p = pattern[i] as string;
      const s = segments[i] as string;
      if (p.startsWith(":")) ok = s.length > 0;
      else if (p === s) score += 1;
      else ok = false;
    }
    if (ok && score > bestScore) {
      best = endpoint;
      bestScore = score;
    }
  }
  return best;
}

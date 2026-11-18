import type { CollectionLimits } from "./collection-json.ts";

/**
 * Only routes whose success contract is an article array may stream around the
 * ordinary whole-response buffer. Similar prefixes, details, identities, media
 * and arbitrary mutations keep their existing fences. This grants no API access.
 */
export function articleCollectionLimits(path: string, method: string): CollectionLimits | null {
  if (path.includes("#") || !path.startsWith("api/v1/")) return null;
  const index = path.indexOf("?");
  const pathname = index === -1 ? path : path.slice(0, index);
  const params = new URLSearchParams(index === -1 ? "" : path.slice(index + 1));
  let defaultLimit: number;
  let ceiling = 100;
  let locales = 1;
  if (pathname === "api/v1/featured" && (method === "GET" || method === "PUT")) {
    defaultLimit = ceiling = 20;
  } else if (method !== "GET") return null;
  else if (pathname === "api/v1/articles" || /^api\/v1\/(?:authors|categories|tags)\/[^/?]+\/articles$/.test(pathname)) {
    defaultLimit = 20;
  } else if (/^api\/v1\/articles\/[^/?]+\/related$/.test(pathname)) {
    defaultLimit = 6; ceiling = 50;
  } else if (pathname === "api/v1/me/articles" || pathname === "api/v1/me/articles/deleted") {
    defaultLimit = 50;
    if (params.get("allLocales") === "true") locales = 3;
  } else if (pathname === "api/v1/me/liked-articles") defaultLimit = 50;
  else if (pathname === "api/v1/me/feed") defaultLimit = 20;
  else return null;
  const raw = params.get("limit");
  const value = raw === null ? defaultLimit : /^\d+$/.test(raw) ? Number(raw) : NaN;
  // Malformed inputs still reach the authoritative API and receive its 400;
  // they cannot create an unlimited collection allowance in this forwarder.
  const limit = Number.isSafeInteger(value) && value >= 1 && value <= 100 ? Math.min(value, ceiling) : ceiling;
  return { maxItems: limit * locales };
}

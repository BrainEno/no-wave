import { homePath, type Locale } from "./content.ts";
import { localeQuery } from "./locale-query.ts";

export type LocalePage = "home" | "article" | "tag" | "archive" | "authors" | "author" | "categories" | "category" | "tags" | "search" | "feed" | "messages" | "conversation" | "notifications" | "reading-list";
export type LocaleDestination = Readonly<{ href: string; page: LocalePage; exact: boolean }>;
const LOCAL_ORIGIN = "https://navigation.no-wave.invalid";
const SEGMENT_LIMIT = 300;

export function localeOf(pathname: string): Locale {
  return pathname === "/en" || pathname.startsWith("/en/") ? "en" : "zh-CN";
}

export function notificationInboxPath(locale: Locale): string {
  return locale === "en" ? "/en/notifications" : "/notifications";
}

function localAddress(value: string): URL | null {
  if (typeof value !== "string" || value.length > 8192 || !value.startsWith("/") || value.startsWith("//")) return null;
  if (/[\\\u0000-\u0020\u007f]/.test(value)) return null;
  const rawPath = value.split(/[?#]/, 1)[0]!;
  // URL normalizes dot segments. Reject before parsing, rather than silently
  // turning an unrecognized address into a different registered page.
  for (const part of rawPath.split("/")) {
    let decoded: string;
    try { decoded = decodeURIComponent(part); } catch { return null; }
    if (decoded === "." || decoded === ".." || /[%\\/\u0000-\u0020\u007f]/.test(decoded)) return null;
    if (decoded.length > SEGMENT_LIMIT) return null;
  }
  try {
    const address = new URL(value, LOCAL_ORIGIN);
    return address.origin === LOCAL_ORIGIN ? address : null;
  } catch { return null; }
}

function pageFor(parts: readonly string[], sameLocale: boolean): { page: LocalePage; bare: string; exact: boolean } | null {
  const [root, identifier] = parts;
  if (parts.length === 0) return { page: "home", bare: "/", exact: true };
  const bare = "/" + parts.join("/");
  if (parts.length === 1) {
    switch (root) {
      case "articles": return { page: "archive", bare, exact: true };
      case "authors": return { page: "authors", bare, exact: true };
      case "categories": return { page: "categories", bare, exact: true };
      case "tags": return { page: "tags", bare, exact: true };
      case "search": return { page: "search", bare, exact: true };
      case "feed": return { page: "feed", bare, exact: true };
      case "messages": return { page: "messages", bare, exact: true };
      case "notifications": return { page: "notifications", bare, exact: true };
      case "reading-list": return { page: "reading-list", bare, exact: true };
      default: return null;
    }
  }
  if (parts.length !== 2 || !identifier) return null;
  switch (root) {
    case "authors": return { page: "author", bare, exact: true };
    case "categories": return { page: "category", bare, exact: true };
    case "messages": return { page: "conversation", bare, exact: true };
    // A translated identity is not proven by changing a prefix. Keep the
    // explicit directory fallback, including for unknown/deleted editions.
    case "articles": return sameLocale ? { page: "article", bare, exact: true } : { page: "archive", bare: "/articles", exact: false };
    case "tags": return sameLocale ? { page: "tag", bare, exact: true } : { page: "tags", bare: "/tags", exact: false };
    default: return null;
  }
}

function hashFor(page: LocalePage, hash: string): string {
  if (!hash) return "";
  let value: string;
  try { value = decodeURIComponent(hash.slice(1)); } catch { return ""; }
  if (!/^[a-zA-Z][a-zA-Z0-9_:.-]{0,127}$/.test(value)) return "";
  if (page === "home" && !["top", "selected", "latest", "topics"].includes(value)) return "";
  return "#" + encodeURIComponent(value);
}

/** Resolve only real bilingual pages; never manufacture /en/write or API URLs. */
export function localeDestination(location: string, target: Locale): LocaleDestination {
  const fallback: LocaleDestination = { href: homePath(target), page: "home", exact: false };
  const address = localAddress(location);
  if (!address) return fallback;
  let pathname = address.pathname;
  if (pathname === "/en" || pathname.startsWith("/en/")) pathname = pathname.slice(3) || "/";
  if (pathname.endsWith("/") && pathname !== "/") pathname = pathname.slice(0, -1);
  const parts = pathname === "/" ? [] : pathname.slice(1).split("/");
  if (parts.some(part => part.length === 0)) return fallback;
  const matched = pageFor(parts, localeOf(address.pathname) === target);
  if (!matched) return fallback;
  const path = target === "en" ? (matched.bare === "/" ? "/en" : "/en" + matched.bare) : matched.bare;
  // Private credentials, unknown query parameters and resource cursors cannot
  // hitch a ride to an unrelated page or appear in a fallback directory URL.
  const suffix = matched.exact ? localeQuery(matched.page, address.searchParams) + hashFor(matched.page, address.hash) : "";
  return { href: path + suffix, page: matched.page, exact: matched.exact };
}

export function alternatePath(location: string, locale: Locale): string {
  return localeDestination(location, locale === "en" ? "zh-CN" : "en").href;
}

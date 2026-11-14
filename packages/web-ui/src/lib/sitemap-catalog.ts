import { resolveUpstreamTimeoutMs, withUpstreamDeadline } from "@bot-thk/web-http";
import { resolveApiBaseUrl } from "./api-content.ts";
import { listArticles as listFixtureArticles, supportedLocales } from "./content.ts";
import { feedTimestamp } from "./feed-text.ts";
import { isTagSlug } from "./tag-discovery.ts";

export const SITEMAP_PAGE_SIZE = 100;
export const SITEMAP_MAX_PAGES = 50;
export const SITEMAP_API_BODY_LIMIT = 8 * 1024 * 1024;
export type SitemapLocale = (typeof supportedLocales)[number];
export type SitemapPageOptions = { locale: SitemapLocale; limit: number; offset: number; signal?: AbortSignal };
export type SitemapReference = { slug: string; locale: SitemapLocale };
export type SitemapAuthor = { username: string; locale: SitemapLocale };
export type SitemapArticle = SitemapReference & { publishedAt: string; updatedAt?: string };
export type SitemapSource = {
  listArticles(options: SitemapPageOptions): Promise<SitemapArticle[]>;
  listAuthors(options: SitemapPageOptions): Promise<SitemapAuthor[]>;
  listCategories(options: SitemapPageOptions): Promise<SitemapReference[]>;
  listTags(options: SitemapPageOptions): Promise<SitemapReference[]>;
};
type FetchCatalog = (input: string, init?: RequestInit) => Promise<Response>;
type RecordValue = Record<string, unknown>;
function record(value: unknown): value is RecordValue { return value !== null && typeof value === "object" && !Array.isArray(value); }
function invalid(): Error { return new Error("Invalid sitemap catalog response."); }
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function count(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }

/** Opaque API identifiers need encoding, not a guessed UUID or username pattern. */
export function isSitemapAuthorId(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 300 || value.trim() !== value || value === "." || value === ".." || /[\x00-\x1f\x7f]/.test(value)) return false;
  try { encodeURIComponent(value); return true; } catch { return false; }
}

export function normalizeSitemapArticle(value: unknown, locale: SitemapLocale): SitemapArticle {
  if (!record(value) || !isTagSlug(value.slug) || value.locale !== locale || typeof value.publishedAt !== "string") throw invalid();
  const publishedAt = feedTimestamp(value.publishedAt);
  if (value.updatedAt !== undefined && value.updatedAt !== null && typeof value.updatedAt !== "string") throw invalid();
  return { slug: value.slug, locale, publishedAt,
    ...(typeof value.updatedAt === "string" ? { updatedAt: feedTimestamp(value.updatedAt) } : {}) };
}

function validatePage({ locale, limit, offset, signal }: SitemapPageOptions): void {
  signal?.throwIfAborted();
  if (!(supportedLocales as readonly string[]).includes(locale) || !Number.isInteger(limit) || limit < 1 || limit > SITEMAP_PAGE_SIZE ||
      !Number.isInteger(offset) || offset < 0 || offset > (SITEMAP_MAX_PAGES - 1) * SITEMAP_PAGE_SIZE) throw new RangeError("Invalid sitemap catalog page.");
}

/** Bound decoded response bytes, not a potentially compressed or dishonest Content-Length. */
async function readCatalog(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") ||
      (declared !== null && /^\d+$/.test(declared) && Number(declared) > SITEMAP_API_BODY_LIMIT) || !response.body) {
    await response.body?.cancel();
    throw invalid();
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = [];
  let bytes = 0;
  try {
    signal.throwIfAborted();
    while (true) {
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > SITEMAP_API_BODY_LIMIT) throw new Error("Sitemap catalog body exceeds its byte limit.");
      parts.push(decoder.decode(next.value, { stream: true }));
    }
    parts.push(decoder.decode());
    return JSON.parse(parts.join("")) as unknown;
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Strict crawl-only projections: ordinary reader pages retain their existing compatibility policy. */
export function createApiSitemapSource({ endpoint, fetchImpl = fetch, timeoutMs }: {
  endpoint: string; fetchImpl?: FetchCatalog; timeoutMs?: number | string | null;
}): SitemapSource {
  const configured = resolveApiBaseUrl({ explicitUrl: endpoint });
  if (!configured) throw new Error("A sitemap catalog API endpoint is required.");
  const base = configured.replace(/\/+$/, "") + "/";
  const budget = resolveUpstreamTimeoutMs(timeoutMs);
  async function page(collection: string, options: SitemapPageOptions): Promise<unknown[]> {
    validatePage(options);
    const url = new URL(`api/v1/${collection}`, base);
    for (const [key, value] of Object.entries({ locale: options.locale, limit: options.limit, offset: options.offset })) url.searchParams.set(key, String(value));
    if (collection === "articles") url.searchParams.set("sort", "latest");
    const payload = await withUpstreamDeadline(budget, async (deadline) => {
      const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
      signal.throwIfAborted();
      const response = await fetchImpl(url.toString(), { method: "GET", headers: { accept: "application/json" },
        cache: "no-store", credentials: "omit", redirect: "error", signal });
      signal.throwIfAborted();
      if (!response.ok) { await response.body?.cancel(); throw new Error("Sitemap catalog API is unavailable."); }
      return readCatalog(response, signal);
    });
    options.signal?.throwIfAborted();
    if (!record(payload) || (payload.error !== undefined && payload.error !== null) || !Array.isArray(payload.data) || payload.data.length > options.limit) throw invalid();
    return payload.data;
  }
  async function taxonomy(collection: "categories" | "tags", options: SitemapPageOptions): Promise<SitemapReference[]> {
    return (await page(collection, options)).map((value) => {
      if (!record(value) || !isTagSlug(value.slug) || value.locale !== options.locale || !text(value.name) || !count(value.articleCount)) throw invalid();
      return { slug: value.slug, locale: options.locale };
    });
  }
  return Object.freeze({
    async listArticles(options: SitemapPageOptions) {
      return (await page("articles", options)).map((value) => {
        if (!record(value) || value.status !== "published" || (value.deletedAt !== undefined && value.deletedAt !== null) ||
            !text(value.title) || !record(value.author) || !isSitemapAuthorId(value.author.userId) || !text(value.author.displayName)) throw invalid();
        return normalizeSitemapArticle(value, options.locale);
      });
    },
    async listAuthors(options: SitemapPageOptions) {
      return (await page("authors", options)).map((value) => {
        if (!record(value) || !isSitemapAuthorId(value.userId) || !text(value.displayName) ||
            !(["zh-CN", "zh-TW", "en"] as readonly unknown[]).includes(value.locale) || !count(value.followerCount) || !count(value.workCount) || value.workCount < 1) throw invalid();
        // Profile labels may fall back (ADR 0024). The directory's query, not
        // that label's translation, establishes the public work locale.
        return { username: value.userId, locale: options.locale };
      });
    },
    listCategories: (options: SitemapPageOptions) => taxonomy("categories", options),
    listTags: (options: SitemapPageOptions) => taxonomy("tags", options),
  });
}

/** Explicit no-API mode only. A failed configured API must never fall back here. */
export function createFixtureSitemapSource(): SitemapSource {
  return {
    async listArticles(options) { validatePage(options); return listFixtureArticles(options).map((article) => normalizeSitemapArticle(article, options.locale)); },
    async listAuthors(options) {
      validatePage(options);
      const authors = [...new Set(listFixtureArticles({ locale: options.locale }).map((article) => article.author.username))];
      return authors.slice(options.offset, options.offset + options.limit).map((username) => ({ username, locale: options.locale }));
    },
    async listCategories(options) { validatePage(options); return []; },
    async listTags(options) { validatePage(options); return []; },
  };
}

export function configuredSitemapSource(): SitemapSource {
  const endpoint = resolveApiBaseUrl();
  return endpoint ? createApiSitemapSource({ endpoint, timeoutMs: process.env.API_TIMEOUT_MS }) : createFixtureSitemapSource();
}

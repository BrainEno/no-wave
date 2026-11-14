import { resolveUpstreamTimeoutMs, withUpstreamDeadline } from "@bot-thk/web-http";
import { archivePath, articlePath, authorPath, homePath, supportedLocales } from "./content.ts";
import { isTagSlug, tagIndexPath, tagPath } from "./tag-discovery.ts";
import { configuredSitemapSource, isSitemapAuthorId, normalizeSitemapArticle, SITEMAP_MAX_PAGES, SITEMAP_PAGE_SIZE,
  type SitemapLocale, type SitemapPageOptions, type SitemapSource } from "./sitemap-catalog.ts";

export { SITEMAP_MAX_PAGES, SITEMAP_PAGE_SIZE } from "./sitemap-catalog.ts";
export type SitemapChangeFrequency = "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
export type SitemapEntry = { url: string; lastModified?: Date; changeFrequency?: SitemapChangeFrequency; priority?: number };
export const SITEMAP_MAX_ENTRIES = 50_000;
export const SITEMAP_MAX_BYTES = 50 * 1024 * 1024;
/** One whole scan budget, in addition to the API's per-call deadline. */
export const SITEMAP_TIMEOUT_MS = 15_000;
const CONTROL = /[\x00-\x1f\x7f]/;
const FREQUENCIES = new Set(["always", "hourly", "daily", "weekly", "monthly", "yearly", "never"]);

/** Errors never include a rejected URL: configuration can contain credentials. */
function httpUrl(value: string): URL {
  try {
    if (CONTROL.test(value)) throw new Error();
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error();
    return url;
  } catch { throw new Error("Invalid public site origin or sitemap location."); }
}

export function siteOrigin(siteUrl: string | undefined): string {
  if (siteUrl !== undefined && CONTROL.test(siteUrl)) throw new Error("Invalid public site origin.");
  return httpUrl(siteUrl?.trim() || "https://example.invalid").origin;
}

/** SITE_URL wins; keep the retired deployment name as a runtime compatibility alias. */
export function configuredSiteUrl(): string {
  return siteOrigin(process.env.SITE_URL ?? process.env.NEXT_PUBLIC_SITE_URL);
}

export type SitemapOptions = { siteUrl?: string; maxPages?: number; timeoutMs?: number; source?: SitemapSource };

/**
 * Four independent, sequential scans per public locale. Each has at most 50
 * pages of 100 rows; none performs per-item detail queries. Reaching the ceiling
 * publishes that bounded window, not a claim of a complete historical export.
 * An upstream error, invalid row or cancelled scan instead fails the whole map.
 */
export async function loadSitemapEntries(options: SitemapOptions = {}): Promise<SitemapEntry[]> {
  const base = siteOrigin(options.siteUrl);
  const maxPages = options.maxPages ?? SITEMAP_MAX_PAGES;
  const timeout = resolveUpstreamTimeoutMs(options.timeoutMs ?? SITEMAP_TIMEOUT_MS);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > SITEMAP_MAX_PAGES) throw new RangeError("Invalid sitemap page limit.");
  return withUpstreamDeadline(timeout, async (signal) => {
    const source = options.source ?? configuredSitemapSource();
    const entries = new Map<string, SitemapEntry>();
    function add(path: string, priority: number, changeFrequency: SitemapChangeFrequency, lastModified?: Date) {
      const url = new URL(path, base).toString();
      const previous = entries.get(url);
      // Overlapping offset pages can occur during publication. Keep one URL and
      // its newest actual modification instant, never a request-time timestamp.
      if (!previous || (lastModified && (!previous.lastModified || lastModified > previous.lastModified))) {
        entries.set(url, { url, priority, changeFrequency, ...(lastModified ? { lastModified } : {}) });
      }
      if (entries.size > SITEMAP_MAX_ENTRIES) throw new Error("Sitemap entry limit exceeded.");
    }
    async function scan<T>(locale: SitemapLocale, list: (page: SitemapPageOptions) => Promise<T[]>, visit: (row: T) => string) {
      const seen = new Set<string>();
      for (let page = 0; page < maxPages; page++) {
        signal.throwIfAborted();
        const rows = await list({ locale, limit: SITEMAP_PAGE_SIZE, offset: page * SITEMAP_PAGE_SIZE, signal });
        signal.throwIfAborted();
        if (!Array.isArray(rows) || rows.length > SITEMAP_PAGE_SIZE) throw new Error("Invalid sitemap catalog page.");
        const pageIds = new Set<string>();
        let newRows = 0;
        for (const row of rows) {
          const id = visit(row);
          if (pageIds.has(id)) throw new Error("Duplicate sitemap catalog identity in one page.");
          pageIds.add(id);
          if (!seen.has(id)) newRows++;
          seen.add(id);
        }
        if (rows.length < SITEMAP_PAGE_SIZE) break;
        if (!newRows) throw new Error("Sitemap catalog pagination made no progress.");
      }
    }
    for (const locale of supportedLocales) {
      const prefix = locale === "en" ? "/en" : "";
      add(homePath(locale), 1, "daily");
      add(archivePath(locale), 0.8, "daily");
      add(`${prefix}/authors`, 0.5, "daily");
      add(`${prefix}/categories`, 0.5, "daily");
      add(tagIndexPath(locale), 0.5, "daily");
      await scan(locale, (page) => source.listArticles(page), (row) => {
        const article = normalizeSitemapArticle(row, locale);
        const published = new Date(article.publishedAt);
        const modified = article.updatedAt ? new Date(article.updatedAt) : published;
        add(articlePath(article.slug, locale), 0.7, "weekly", modified > published ? modified : published);
        return article.slug;
      });
      await scan(locale, (page) => source.listAuthors(page), (author) => {
        if (!author || author.locale !== locale || !isSitemapAuthorId(author.username)) throw new Error("Invalid sitemap author identity.");
        add(authorPath(author.username, locale), 0.5, "weekly");
        return author.username;
      });
      for (const kind of ["categories", "tags"] as const) {
        await scan(locale, (page) => kind === "categories" ? source.listCategories(page) : source.listTags(page), (item) => {
          if (!item || item.locale !== locale || !isTagSlug(item.slug)) throw new Error("Invalid sitemap taxonomy identity.");
          add(kind === "tags" ? tagPath(item.slug, locale) : `${prefix}/categories/${encodeURIComponent(item.slug)}`, 0.5, "weekly");
          return item.slug;
        });
      }
    }
    // Directory reach/order may change without the URL set changing. Sorting
    // gives the same representation (and validator) for the same crawl facts.
    return [...entries.values()].sort((left, right) => left.url < right.url ? -1 : left.url > right.url ? 1 : 0);
  });
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function validateLocation(value: string): void {
  if (typeof value !== "string" || !value || value.length > 2048 || value.trim() !== value) throw new Error("Invalid sitemap location.");
  httpUrl(value);
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if ((point >= 0xd800 && point <= 0xdfff) || point === 0xfffe || point === 0xffff) throw new Error("Invalid sitemap XML location.");
  }
}

/** Validate the protocol envelope too; this renderer is callable without the scanner. */
export function renderSitemapXml(entries: readonly SitemapEntry[]): string {
  if (entries.length > SITEMAP_MAX_ENTRIES) throw new Error("Sitemap entry limit exceeded.");
  const opening = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  const closing = "</urlset>\n";
  const encoder = new TextEncoder();
  let bytes = encoder.encode(opening + closing).byteLength;
  const urls = entries.map((entry) => {
    validateLocation(entry.url);
    const parts = [`<loc>${escapeXml(entry.url)}</loc>`];
    if (entry.lastModified !== undefined) {
      if (!(entry.lastModified instanceof Date) || !Number.isFinite(entry.lastModified.getTime())) throw new Error("Invalid sitemap date.");
      parts.push(`<lastmod>${entry.lastModified.toISOString()}</lastmod>`);
    }
    if (entry.changeFrequency !== undefined) {
      if (!FREQUENCIES.has(entry.changeFrequency)) throw new Error("Invalid sitemap change frequency.");
      parts.push(`<changefreq>${entry.changeFrequency}</changefreq>`);
    }
    if (entry.priority !== undefined) {
      if (!Number.isFinite(entry.priority) || entry.priority < 0 || entry.priority > 1) throw new Error("Invalid sitemap priority.");
      parts.push(`<priority>${entry.priority.toFixed(1)}</priority>`);
    }
    const xml = `  <url>\n    ${parts.join("\n    ")}\n  </url>\n`;
    bytes += encoder.encode(xml).byteLength;
    if (bytes > SITEMAP_MAX_BYTES) throw new Error("Sitemap XML byte limit exceeded.");
    return xml;
  });
  return opening + urls.join("") + closing;
}

export function renderRobotsTxt(siteUrl?: string): string {
  return `User-Agent: *\nAllow: /\n\nSitemap: ${new URL("/sitemap.xml", siteOrigin(siteUrl)).toString()}\n`;
}

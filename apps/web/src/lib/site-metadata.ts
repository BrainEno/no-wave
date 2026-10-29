import { archivePath, articlePath, authorPath, homePath, supportedLocales } from "./content.ts";
import { listPublicArticles } from "./api-content.ts";

/**
 * Sitemap and robots output, framework-neutral.
 *
 * Both are public, crawlable surfaces with the same requirements in every
 * framework: absolute URLs built from the configured site origin, one entry per
 * localized URL, and a stable XML/text shape. Keeping the builders here means the
 * Next.js `app/sitemap.ts`/`app/robots.ts` conventions and the React Router
 * resource routes produce byte-identical output instead of two implementations
 * that drift the first time an entry is added.
 */

export type SitemapChangeFrequency =
  | "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";

export type SitemapEntry = {
  url: string;
  lastModified?: Date;
  changeFrequency?: SitemapChangeFrequency;
  priority?: number;
};

/** Page size for the article scan; the API caps a single list at 100 anyway. */
export const SITEMAP_PAGE_SIZE = 100;
/**
 * Ceiling on how many article pages the sitemap will scan per locale.
 *
 * The App Router version looped until the API returned a short page, which is
 * unbounded work per request. On a small instance a crawler-triggered sitemap
 * must not be able to fan out indefinitely, so the scan stops here and the
 * sitemap covers the newest `SITEMAP_PAGE_SIZE * SITEMAP_MAX_PAGES` works per
 * locale.
 */
export const SITEMAP_MAX_PAGES = 50;

export function siteOrigin(siteUrl: string | undefined): string {
  return siteUrl?.trim() || "https://example.invalid";
}

/**
 * Build every indexable URL.
 *
 * Authors are collected from the articles actually listed, so the sitemap never
 * points at a profile the site does not link to, and each author appears once per
 * locale.
 */
export async function loadSitemapEntries(
  options: { siteUrl?: string; maxPages?: number } = {},
): Promise<SitemapEntry[]> {
  const baseUrl = siteOrigin(options.siteUrl);
  const maxPages = options.maxPages ?? SITEMAP_MAX_PAGES;
  const entries: SitemapEntry[] = [];
  const seenAuthors = new Set<string>();

  for (const locale of supportedLocales) {
    entries.push({ url: new URL(homePath(locale), baseUrl).toString(), changeFrequency: "daily", priority: 1 });
    entries.push({ url: new URL(archivePath(locale), baseUrl).toString(), changeFrequency: "daily", priority: 0.8 });

    let offset = 0;
    for (let page = 0; page < maxPages; page += 1) {
      const articles = await listPublicArticles({ locale, limit: SITEMAP_PAGE_SIZE, offset });
      for (const article of articles) {
        entries.push({
          url: new URL(articlePath(article.slug, locale), baseUrl).toString(),
          lastModified: new Date(article.publishedAt),
          changeFrequency: "weekly",
          priority: 0.7,
        });
        const authorKey = `${locale}:${article.author.username}`;
        if (!seenAuthors.has(authorKey)) {
          seenAuthors.add(authorKey);
          entries.push({
            url: new URL(authorPath(article.author.username, locale), baseUrl).toString(),
            changeFrequency: "weekly",
            priority: 0.5,
          });
        }
      }
      if (articles.length < SITEMAP_PAGE_SIZE) break;
      offset += articles.length;
    }
  }

  return entries;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function renderSitemapXml(entries: readonly SitemapEntry[]): string {
  const urls = entries.map((entry) => {
    const parts = [`<loc>${escapeXml(entry.url)}</loc>`];
    if (entry.lastModified instanceof Date && !Number.isNaN(entry.lastModified.getTime())) {
      parts.push(`<lastmod>${entry.lastModified.toISOString()}</lastmod>`);
    }
    if (entry.changeFrequency) parts.push(`<changefreq>${escapeXml(entry.changeFrequency)}</changefreq>`);
    if (typeof entry.priority === "number") parts.push(`<priority>${entry.priority.toFixed(1)}</priority>`);
    return `  <url>\n    ${parts.join("\n    ")}\n  </url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

export function renderRobotsTxt(siteUrl?: string): string {
  const baseUrl = siteOrigin(siteUrl);
  return [
    "User-Agent: *",
    "Allow: /",
    "",
    `Sitemap: ${new URL("/sitemap.xml", baseUrl).toString()}`,
    "",
  ].join("\n");
}

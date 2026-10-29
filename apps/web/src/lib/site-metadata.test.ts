import assert from "node:assert/strict";
import test from "node:test";

import {
  renderRobotsTxt,
  renderSitemapXml,
  loadSitemapEntries,
  siteOrigin,
  type SitemapEntry,
} from "./site-metadata.ts";
import { supportedLocales } from "./content.ts";

/**
 * Sitemap/robots output is a public contract: search engines consume it and both
 * frameworks must publish the same URLs. These assertions pin the shape, the
 * escaping and the per-locale author de-duplication without requiring a server.
 */

const SITE = "https://no-wave.test";

test("the site origin falls back to the documented placeholder only when unset", () => {
  assert.equal(siteOrigin("https://no-wave.test"), "https://no-wave.test");
  assert.equal(siteOrigin("  https://no-wave.test  "), "https://no-wave.test");
  assert.equal(siteOrigin(undefined), "https://example.invalid");
  assert.equal(siteOrigin("   "), "https://example.invalid");
});

test("the XML is well-formed, escaped and ordered the way it was built", () => {
  const entries: SitemapEntry[] = [
    { url: `${SITE}/?a=1&b=2`, changeFrequency: "daily", priority: 1 },
    { url: `${SITE}/articles/中文作品`, lastModified: new Date("2026-10-01T09:00:00.000Z"), changeFrequency: "weekly", priority: 0.7 },
    { url: `${SITE}/authors/writer` },
  ];
  const xml = renderSitemapXml(entries);

  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n/);
  assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  // `&` must be escaped, or the document is not parseable.
  assert.match(xml, /<loc>https:\/\/no-wave\.test\/\?a=1&amp;b=2<\/loc>/);
  assert.match(xml, /<lastmod>2026-10-01T09:00:00\.000Z<\/lastmod>/);
  assert.match(xml, /<priority>1\.0<\/priority>/);
  assert.match(xml, /<priority>0\.7<\/priority>/);
  // An entry without optional fields emits only its location.
  assert.match(xml, /<url>\n {4}<loc>https:\/\/no-wave\.test\/authors\/writer<\/loc>\n {2}<\/url>/);
  assert.equal((xml.match(/<url>/g) ?? []).length, 3);
});

test("robots.txt allows crawling and points at the sitemap", () => {
  const text = renderRobotsTxt(SITE);
  assert.match(text, /^User-Agent: \*\nAllow: \/\n/);
  assert.match(text, /Sitemap: https:\/\/no-wave\.test\/sitemap\.xml/);
  assert.equal(renderRobotsTxt(undefined).includes("https://example.invalid/sitemap.xml"), true);
});

test("every locale publishes home, archive, article and author URLs, authors once", async () => {
  const entries = await loadSitemapEntries({ siteUrl: SITE });
  const urls = entries.map((entry) => entry.url);

  for (const locale of supportedLocales) {
    assert.ok(urls.includes(new URL(locale === "zh-CN" ? "/" : "/en", SITE).toString()), `missing ${locale} home`);
    assert.ok(urls.some((url) => url.endsWith(locale === "zh-CN" ? "/articles" : "/en/articles")), `missing ${locale} archive`);
    assert.ok(urls.some((url) => url.includes(locale === "zh-CN" ? "/articles/" : "/en/articles/")), `missing ${locale} articles`);
    assert.ok(urls.some((url) => url.includes(locale === "zh-CN" ? "/authors/" : "/en/authors/")), `missing ${locale} authors`);
  }

  const authorUrls = urls.filter((url) => url.includes("/authors/"));
  assert.equal(new Set(authorUrls).size, authorUrls.length, "an author must not be listed twice");
  assert.ok(entries.every((entry) => entry.url.startsWith(SITE)), "every URL must be absolute");
  assert.ok(entries.every((entry) => entry.priority === undefined || (entry.priority >= 0 && entry.priority <= 1)));
});

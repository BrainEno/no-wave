import assert from "node:assert/strict";
import test from "node:test";
import { loadSitemapEntries, renderRobotsTxt, renderSitemapXml, siteOrigin } from "./site-metadata.ts";

const SITE = "https://publisher.example";

test("public crawl output never publishes credentials, control characters or a non-HTTP origin", () => {
  for (const value of ["https://reader:private@publisher.example", "javascript:active()", "file:///tmp/site", "ftp://publisher.example", "/relative", "https://publisher.example\r\nDisallow: /", "https://pub\tlisher.example", "https://publisher.example\0"]) {
    assert.throws(() => siteOrigin(value), /site origin/i, value.replace(/[^\x20-\x7e]/g, "?"));
    assert.throws(() => renderRobotsTxt(value), /site origin/i);
  }
});

test("a configured site URL contributes exactly its origin, never its path, query or fragment", () => {
  assert.equal(siteOrigin(" HTTPS://Publisher.Example:443/base/?internal=value#section "), SITE);
  assert.equal(siteOrigin("http://localhost:3000/subdirectory"), "http://localhost:3000");
  assert.equal(siteOrigin("https://[::1]:8443/path"), "https://[::1]:8443");
  assert.equal(siteOrigin("https://例子.测试/路径"), new URL("https://例子.测试").origin);
  assert.equal(siteOrigin(undefined), "https://example.invalid");
  assert.equal(siteOrigin("  "), "https://example.invalid");
  assert.equal(renderRobotsTxt(`${SITE}/base?internal=value#fragment`), `User-Agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
});

test("invalid origin is rejected before any catalog request can consume a budget", async () => {
  let reads = 0;
  const list = async () => { reads++; return []; };
  await assert.rejects(loadSitemapEntries({ siteUrl: "https://name:private@publisher.example", source: {
    listArticles: list, listAuthors: list, listCategories: list, listTags: list,
  } }), /site origin/i);
  assert.equal(reads, 0);
});

test("XML rendering refuses unsafe locations rather than escaping an active or credential-bearing URL", () => {
  for (const url of ["javascript:active()", "data:text/plain,private", "//outside.example/path", "https://name:private@publisher.example", `${SITE}/bad\npath`, ""]) {
    assert.throws(() => renderSitemapXml([{ url }]), /sitemap|site origin|location/i);
  }
});

test("invalid dates, priorities and update frequencies cannot create a misleading sitemap", () => {
  assert.throws(() => renderSitemapXml([{ url: SITE, lastModified: new Date("not-a-date") }]), /sitemap|date/i);
  for (const priority of [-0.1, 1.1, NaN, Infinity]) assert.throws(() => renderSitemapXml([{ url: SITE, priority }]), /priority|sitemap/i);
  const invalid = { url: SITE, changeFrequency: "sometimes" };
  assert.throws(() => renderSitemapXml([invalid as Parameters<typeof renderSitemapXml>[0][number]]), /frequency|sitemap/i);
});

test("the XML protocol entry ceiling is enforced before formatting the document", () => {
  const entries = Array.from({ length: 50_001 }, (_, index) => ({ url: `${SITE}/articles/work-${index}` }));
  assert.throws(() => renderSitemapXml(entries), /limit|sitemap/i);
});

test("valid UTF-8 locations remain text, and literal XML delimiters cannot become markup", () => {
  const xml = renderSitemapXml([{ url: `${SITE}/?q=𠀀&other="<script>"` }]);
  assert.match(xml, /𠀀&amp;other=&quot;&lt;script&gt;&quot;/);
  assert.doesNotMatch(xml, /<script>/);
  assert.equal((xml.match(/<loc>/g) ?? []).length, 1);
});


test("location length and XML character validity are enforced without damaging supplementary Unicode", () => {
  for (const url of [`${SITE}/?q=${"x".repeat(2048)}`, `${SITE}/\ud800`, `${SITE}/\ufffe`]) {
    assert.throws(() => renderSitemapXml([{ url }]), /sitemap|location/i);
  }
});

test("the protocol byte ceiling includes escaped XML text, not just URL count or raw string length", () => {
  const url = `${SITE}/?q=${"&".repeat(1500)}`;
  assert.ok(url.length < 2048);
  assert.throws(() => renderSitemapXml(Array.from({ length: 8000 }, () => ({ url }))), /byte limit/i);
});

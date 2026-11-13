import { expect, type Page } from "@playwright/test";
import { test } from "./support/tag-stack.ts";
import { tagAuthor, tagNonce } from "./support/tag-author.ts";

const ATOM = "http://www.w3.org/2005/Atom";
async function parseSubscription(page: Page, body: string, format: "atom" | "rss") {
  return page.evaluate(({ xml, kind, atom }) => {
    const document = new DOMParser().parseFromString(xml, "application/xml");
    const entries = kind === "atom" ? [...document.getElementsByTagNameNS(atom, "entry")] : [...document.getElementsByTagName("item")];
    return {
      errors: document.getElementsByTagName("parsererror").length,
      root: document.documentElement.localName, namespace: document.documentElement.namespaceURI,
      doctype: document.doctype?.name ?? null,
      entries: entries.map((entry) => ({
        title: entry.getElementsByTagName("title")[0]?.textContent,
        id: entry.getElementsByTagName(kind === "atom" ? "id" : "guid")[0]?.textContent,
        summary: entry.getElementsByTagName(kind === "atom" ? "summary" : "description")[0]?.textContent,
        summaryType: entry.getElementsByTagName("summary")[0]?.getAttribute("type"),
        author: kind === "atom" ? entry.getElementsByTagName("name")[0]?.textContent : entry.getElementsByTagNameNS("http://purl.org/dc/elements/1.1/", "creator")[0]?.textContent,
      })),
    };
  }, { xml: body, kind: format, atom: ATOM });
}

test("a real published tag subscription parses as XML, escapes author text and excludes its draft", async ({ page, request, tagStack }) => {
  const writer = await tagAuthor(request, tagStack.apiBaseUrl);
  const tag = await writer.tag(`订阅主题${tagNonce()}`);
  const title = `海边 𠀀 <script>feedExecuted=1</script> & ${tagNonce()}`;
  const summary = '<img src="x" onerror="feedExecuted=1"> & 文本摘要';
  const published = await writer.work(title, tag, true, { summary });
  const draftTitle = `绝不进入订阅的草稿${tagNonce()}`;
  const draft = await writer.work(draftTitle, tag, false);
  await page.goto(`${tagStack.webBaseUrl}/tags/${tag.slug}`);
  const subscriptions = page.getByRole("navigation", { name: "标签订阅", exact: true });
  await expect(subscriptions.getByRole("link", { name: "订阅 Atom", exact: true })).toHaveAttribute("href", `/tags/${tag.slug}/feed.atom`);
  await expect(subscriptions.getByRole("link", { name: "订阅 RSS", exact: true })).toHaveAttribute("href", `/tags/${tag.slug}/feed.xml`);
  for (const [format, extension] of [["atom", "atom"], ["rss", "xml"]] as const) {
    await expect(page.locator(`head link[rel="alternate"][type="application/${format}+xml"]`)).toHaveAttribute("href", `${tagStack.webBaseUrl}/tags/${tag.slug}/feed.${extension}`);
    const response = await request.get(`${tagStack.webBaseUrl}/tags/${tag.slug}/feed.${extension}`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain(`application/${format}+xml`);
    const body = await response.text();
    const audit = await parseSubscription(page, body, format);
    expect(audit.errors).toBe(0);
    expect(audit.doctype).toBeNull();
    expect(audit.root).toBe(format === "atom" ? "feed" : "rss");
    expect(audit.namespace).toBe(format === "atom" ? ATOM : null);
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0].title).toBe(title);
    expect(audit.entries[0].author).toBe("标签作者");
    expect(audit.entries[0].id).toBe(`${tagStack.webBaseUrl}/articles/${published.slug}`);
    expect(body).not.toContain(draft.slug);
    expect(body).not.toContain(draftTitle);
    expect(body).not.toContain("<script>");
    if (format === "atom") {
      expect(audit.entries[0].summaryType).toBe("text");
      expect(audit.entries[0].summary).toBe(summary);
    } else {
      expect(audit.entries[0].summary).toContain("&lt;img");
      expect(audit.entries[0].summary).not.toContain("<img");
    }
    const validated = await request.get(response.url(), { headers: { "if-none-match": response.headers().etag } });
    expect(validated.status()).toBe(304);
    expect(await validated.text()).toBe("");
  }
  expect(await page.evaluate(() => "feedExecuted" in window)).toBe(false);
});

test("English subscriptions link only the matching locale and never manufacture a Chinese tag translation", async ({ page, request, tagStack }) => {
  const writer = await tagAuthor(request, tagStack.apiBaseUrl);
  // Tag REST writes currently accept zh-CN only. Seed an existing English tag
  // in this fixture's private database, then publish and read via the real API.
  const tag = tagStack.seedEnglishTag(`EnglishMemory${tagNonce()}`);
  const title = `An English memory ${tagNonce()}`;
  const published = await writer.work(title, tag, true, { locale: "en", summary: "An English editorial summary." });
  await page.goto(`${tagStack.webBaseUrl}/en/tags/${tag.slug}`);
  const subscription = page.getByRole("navigation", { name: "Tag subscriptions", exact: true });
  await expect(subscription.getByRole("link", { name: "Subscribe with Atom", exact: true })).toBeVisible();
  const response = await request.get(`${tagStack.webBaseUrl}/en/tags/${tag.slug}/feed.atom`);
  expect(response.status()).toBe(200);
  const parsed = await parseSubscription(page, await response.text(), "atom");
  expect(parsed.errors).toBe(0);
  expect(parsed.entries[0].id).toBe(`${tagStack.webBaseUrl}/en/articles/${published.slug}`);
  expect(parsed.entries[0].title).toBe(title);
  const missingTranslation = await request.get(`${tagStack.webBaseUrl}/tags/${tag.slug}/feed.atom`);
  expect(missingTranslation.status()).toBe(404);
  expect(missingTranslation.headers()["cache-control"]).toContain("no-store");
});

test("RSS remains a native keyboard-accessible link on mobile with JavaScript disabled", async ({ browser, request, tagStack }) => {
  const writer = await tagAuthor(request, tagStack.apiBaseUrl);
  const tag = await writer.tag(`无需脚本订阅${tagNonce()}`);
  await writer.work(`无需脚本的作品${tagNonce()}`, tag);
  const context = await browser.newContext({ javaScriptEnabled: false, reducedMotion: "reduce", viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    await page.goto(`${tagStack.webBaseUrl}/tags/${tag.slug}`);
    const link = page.getByRole("link", { name: "订阅 RSS", exact: true });
    await expect(link).toBeVisible();
    const box = await link.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    const widths = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth }));
    expect(widths.document).toBeLessThanOrEqual(widths.viewport + 1);
    await link.focus();
    const [response] = await Promise.all([
      page.waitForResponse((result) => result.url() === `${tagStack.webBaseUrl}/tags/${tag.slug}/feed.xml`),
      page.keyboard.press("Enter"),
    ]);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("application/rss+xml");
    expect((await parseSubscription(page, await response.text(), "rss")).errors).toBe(0);
  } finally { await context.close(); }
});

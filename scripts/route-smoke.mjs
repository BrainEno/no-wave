import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const port = Number(process.env.SMOKE_PORT ?? 3187);
const baseUrl = `http://127.0.0.1:${port}`;
let serverOutput = "";
const server = spawn("pnpm", ["--filter", "@bot-thk/web", "start"], {
  env: { ...process.env, HOSTNAME: "127.0.0.1", PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
  // Keep the package manager and its Next.js child in one process group so cleanup
  // below does not leave the server running after the smoke checks finish.
  detached: process.platform !== "win32",
});

server.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
server.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });

async function waitForServer() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (server.exitCode !== null) {
      throw new Error(`Next.js server exited early (code ${server.exitCode}).\n${serverOutput}`);
    }
    try {
      const response = await fetch(baseUrl, { redirect: "manual" });
      if (response.status === 200) return;
    } catch {
      // The server is still starting.
    }
    await delay(500);
  }
  throw new Error(`Next.js server did not become ready.\n${serverOutput}`);
}

try {
  await waitForServer();

  const home = await fetch(baseUrl);
  assert.equal(home.status, 200, "home page should return 200");
  const homeHtml = await home.text();
  assert.match(homeHtml, /文学作品的数字出版空间/, "default home should serve Simplified Chinese content");
  assert.match(homeHtml, /lang="zh-CN"/, "default content should declare its language");

  const article = await fetch(`${baseUrl}/articles/portable-web-foundation`);
  assert.equal(article.status, 200, "known article should return 200");
  const articleHtml = await article.text();
  assert.match(articleHtml, /rel="canonical"/, "article should render a canonical link");
  assert.match(articleHtml, /og:title/, "article should render Open Graph metadata");

  const archive = await fetch(`${baseUrl}/articles`);
  assert.equal(archive.status, 200, "article archive should return 200");
  assert.match(await archive.text(), /文学作品的数字出版空间/, "article archive should list available content");

  const categories = await fetch(`${baseUrl}/categories`);
  assert.equal(categories.status, 200, "category index should return 200 without API configuration");
  assert.match(await categories.text(), /作品分類/);
  const missingCategory = await fetch(`${baseUrl}/categories/does-not-exist`);
  assert.equal(missingCategory.status, 404, "unknown category should return 404");
  const englishCategories = await fetch(`${baseUrl}/en/categories`);
  assert.equal(englishCategories.status, 200, "English category index should return 200");
  assert.match(await englishCategories.text(), /Explore by category/);

  const search = await fetch(`${baseUrl}/articles?q=不存在的文章`);
  assert.equal(search.status, 200, "empty search should return 200");
  assert.match(await search.text(), /没有符合条件的作品/, "search should provide an empty state");

  const englishHome = await fetch(`${baseUrl}/en`);
  assert.equal(englishHome.status, 200, "English home should return 200");
  assert.match(await englishHome.text(), /lang="en"/, "English content should declare its language");

  const englishArchive = await fetch(`${baseUrl}/en/articles`);
  assert.equal(englishArchive.status, 200, "English article archive should return 200");
  assert.match(await englishArchive.text(), /A Portable Web Foundation/);

  const englishArticle = await fetch(`${baseUrl}/en/articles/portable-web-foundation`);
  assert.equal(englishArticle.status, 200, "English article should return 200");
  const englishArticleHtml = await englishArticle.text();
  assert.match(englishArticleHtml, /rel="canonical"/);
  assert.match(englishArticleHtml, /A Portable Web Foundation/);

  const missingArticle = await fetch(`${baseUrl}/articles/does-not-exist`);
  assert.equal(missingArticle.status, 404, "unknown article should return 404");

  const missingAuthor = await fetch(`${baseUrl}/authors/does-not-exist`);
  assert.equal(missingAuthor.status, 404, "unknown author should return 404");

  const account = await fetch(`${baseUrl}/account`, { redirect: "manual" });
  assert.equal(account.status, 307, "anonymous account request should redirect");
  assert.equal(account.headers.get("location"), "/sign-in?next=%2Faccount");
  assert.match(account.headers.get("cache-control") ?? "", /no-store/i, "account redirect must not be publicly cached");

  const events = await fetch(`${baseUrl}/api/spike/events`);
  assert.equal(events.status, 200);
  assert.match(events.headers.get("content-type") ?? "", /text\/event-stream/i);
  assert.match(events.headers.get("cache-control") ?? "", /no-store/i);
  // SSE responses are intentionally long-lived; response.text() waits for EOF and
  // hangs forever. Read only until the expected event arrives, then cancel the stream.
  const eventsReader = events.body.getReader();
  const eventsDecoder = new TextDecoder();
  let eventsText = "";
  try {
    for (let attempt = 0; attempt < 10 && !/refreshRequired/.test(eventsText); attempt += 1) {
      const { value, done } = await eventsReader.read();
      if (done) break;
      eventsText += eventsDecoder.decode(value, { stream: true });
    }
    assert.match(eventsText, /refreshRequired/, "SSE stream should emit refreshRequired");
  } finally {
    await eventsReader.cancel();
  }

  const robots = await fetch(`${baseUrl}/robots.txt`);
  assert.equal(robots.status, 200);
  assert.match(await robots.text(), /Sitemap:/);

  const sitemap = await fetch(`${baseUrl}/sitemap.xml`);
  assert.equal(sitemap.status, 200);
  const sitemapText = await sitemap.text();
  assert.match(sitemapText, /portable-web-foundation/);
  assert.match(sitemapText, /\/en\/articles\//, "sitemap should include English article URLs");

  console.log("Route smoke checks passed: localized home/archive/article routes, search, SEO alternates, 404s, account cache policy, SSE headers, robots and sitemap.");
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    if (process.platform !== "win32" && server.pid !== undefined) {
      try {
        process.kill(-server.pid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    } else {
      server.kill("SIGTERM");
    }
  }
}

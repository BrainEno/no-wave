import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

const port = Number(process.env.SMOKE_PORT ?? 3187);
const baseUrl = `http://127.0.0.1:${port}`;
let serverOutput = "";
// The smoke checks assert the local fixture registry, so the API origin is
// cleared explicitly: `apps/web/next.config.ts` loads the repository-root
// .env.local, and a developer machine that configured API_BASE_URL there would
// otherwise render API data (or fail) instead of fixtures. An empty value is
// already present in the child environment, so the env file cannot fill it in.
const server = spawn("pnpm", ["--filter", "@bot-thk/web", "start"], {
  env: {
    ...process.env,
    HOSTNAME: "127.0.0.1",
    PORT: String(port),
    API_BASE_URL: "",
    API_SERVICE_URL: "",
    API_GRAPHQL_URL: "",
  },
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

/**
 * Boot the same build on a second port with mail switched on, run `check`, and
 * stop it again.
 *
 * A separate process rather than an env juggle on the first one: the switch is
 * read at request time, so the only way to show the build behaving differently
 * is to serve it twice.
 */
async function withMailEnabledServer(check: (url: string) => Promise<void>): Promise<void> {
  const probe = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") { reject(new Error("Could not reserve a port.")); return; }
      resolve(address.port);
    });
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const mailServer = spawn("pnpm", ["--filter", "@bot-thk/web", "start"], {
    env: { ...process.env, HOSTNAME: "127.0.0.1", PORT: String(port), MAIL_ENABLED: "true", API_BASE_URL: "" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let output = "";
  mailServer.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  mailServer.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  try {
    const url = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 40 && !ready; attempt += 1) {
      try {
        const response = await fetch(`${url}/forgot-password`);
        if (response.status === 200) ready = true;
      } catch { /* still starting */ }
      if (!ready) await delay(500);
    }
    if (!ready) throw new Error(`The mail-enabled server did not become ready.\n${output}`);
    await check(url);
  } finally {
    if (mailServer.exitCode === null && mailServer.signalCode === null) {
      if (process.platform !== "win32" && mailServer.pid !== undefined) {
        try { process.kill(-mailServer.pid, "SIGTERM"); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
      } else {
        mailServer.kill("SIGTERM");
      }
    }
  }
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
  assert.match(await categories.text(), /作品分类/, "category index should serve Simplified Chinese content");
  const missingCategory = await fetch(`${baseUrl}/categories/does-not-exist`);
  assert.equal(missingCategory.status, 404, "unknown category should return 404");
  const englishCategories = await fetch(`${baseUrl}/en/categories`);
  assert.equal(englishCategories.status, 200, "English category index should return 200");
  assert.match(await englishCategories.text(), /Categories are maintained as real publication data/, "English category index should serve English content");

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

  /**
   * Recovery and verification (ADR 0014) with **mail switched off**, which is
   * this script's configuration and the product default: these pages are reached
   * from a mail, so the property that matters is that they never 500 and never
   * collect an address for a link that cannot be sent. The switched-on forms are
   * asserted against a second server below.
   */
  const forgotPassword = await fetch(`${baseUrl}/forgot-password`);
  assert.equal(forgotPassword.status, 200, "the recovery request page should return 200");
  const forgotPasswordHtml = await forgotPassword.text();
  assert.match(forgotPasswordHtml, /未启用邮件功能/, "with mail off the page says so instead of offering a form");
  assert.doesNotMatch(forgotPasswordHtml, /name="email"/, "no address is collected for a mail that cannot be sent");

  const resetWithoutToken = await fetch(`${baseUrl}/reset-password`);
  assert.equal(resetWithoutToken.status, 200, "the reset page should return 200");
  assert.match(await resetWithoutToken.text(), /未启用邮件功能/, "a reset link can only have arrived by mail");

  const verifyWithoutToken = await fetch(`${baseUrl}/verify-email`);
  assert.equal(verifyWithoutToken.status, 200, "the verification page should return 200");
  assert.match(await verifyWithoutToken.text(), /未启用邮件功能/, "same for a verification link");

  const signIn = await fetch(`${baseUrl}/sign-in`);
  assert.equal(signIn.status, 200, "the sign-in page should return 200");
  assert.doesNotMatch(
    await signIn.text(),
    /\/forgot-password/,
    "the recovery link is not offered while the site cannot send a recovery mail",
  );

  const events = await fetch(`${baseUrl}/api/spike/events`);
  assert.equal(events.status, 200);
  assert.match(events.headers.get("content-type") ?? "", /text\/event-stream/i);
  assert.match(events.headers.get("cache-control") ?? "", /no-store/i);
  // SSE responses are intentionally long-lived; response.text() waits for EOF and
  // hangs forever. Read only until the expected event arrives, then cancel the stream.
  assert.ok(events.body, "the SSE response should include a body stream");
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


  const writingDesk = await fetch(`${baseUrl}/write`);
  assert.equal(writingDesk.status, 200, "writing desk should render when the API and media store are not configured");
  const anonymousMediaUpload = await fetch(`${baseUrl}/api/authoring/media`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: Buffer.from("not-an-image"),
  });
  assert.equal(anonymousMediaUpload.status, 403, "media upload proxy must reject cross-origin or origin-less mutations");
  const unavailableMedia = await fetch(`${baseUrl}/api/media/11111111-1111-4111-8111-111111111111`);
  assert.equal(unavailableMedia.status, 503, "public media proxy should report missing API configuration explicitly");
  const commentList = await fetch(`${baseUrl}/api/articles/portable-web-foundation/comments?locale=zh-CN`);
  assert.equal(commentList.status, 503, "comment route should report missing API configuration without fabricating fixture comments");

  const robots = await fetch(`${baseUrl}/robots.txt`);
  assert.equal(robots.status, 200);
  assert.match(await robots.text(), /Sitemap:/);

  const sitemap = await fetch(`${baseUrl}/sitemap.xml`);
  assert.equal(sitemap.status, 200);
  const sitemapText = await sitemap.text();
  assert.match(sitemapText, /portable-web-foundation/);
  assert.match(sitemapText, /\/en\/articles\//, "sitemap should include English article URLs");

  /**
   * The same build with `MAIL_ENABLED=true`.
   *
   * This is the whole point of reading the switch on the server at request time
   * rather than inlining it at build time: one deployment artefact, two
   * behaviours, no rebuild.
   */
  await withMailEnabledServer(async (mailUrl) => {
    const forgotPassword = await fetch(`${mailUrl}/forgot-password`);
    assert.equal(forgotPassword.status, 200);
    const forgotPasswordHtml = await forgotPassword.text();
    assert.match(forgotPasswordHtml, /发送重设链接/, "with mail on the recovery form is offered");
    assert.match(forgotPasswordHtml, /name="email"/);
    assert.doesNotMatch(forgotPasswordHtml, /未启用邮件功能/, "one artefact, two behaviours: the switch is read per request");

    const resetWithToken = await fetch(`${mailUrl}/reset-password?token=${"a".repeat(43)}`);
    assert.equal(resetWithToken.status, 200);
    assert.match(await resetWithToken.text(), /设置新密码/, "a reset link with a token renders the form");

    const verifyWithoutToken = await fetch(`${mailUrl}/verify-email`);
    assert.equal(verifyWithoutToken.status, 200);
    assert.match(await verifyWithoutToken.text(), /链接不完整/, "a verification link without a token must say so");

    const signIn = await fetch(`${mailUrl}/sign-in`);
    assert.match(await signIn.text(), /\/forgot-password/, "the recovery link comes back with the switch");
  });

  console.log("Route smoke checks passed: localized home/archive/article routes, search, SEO alternates, 404s, account cache policy, recovery and verification pages (mail off and on), SSE headers, robots and sitemap.");
} finally {
  if (server.exitCode === null && server.signalCode === null) {
    if (process.platform !== "win32" && server.pid !== undefined) {
      try {
        process.kill(-server.pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    } else {
      server.kill("SIGTERM");
    }
  }
}

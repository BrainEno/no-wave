import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import { MOCK_COMMENT_ID, MOCK_CREDENTIALS, MOCK_DISPLAY_NAME, MOCK_MEDIA, MOCK_TOKENS, startMockRestApi } from "../mocks/rest-api.ts";
import type { MockRestApi } from "../mocks/rest-api.ts";

/**
 * Behavior tests for the isolated React Router 7 prototype.
 *
 * They run against the **production build** served by `node server.ts`, over real
 * HTTP, with a real (mock) REST API on a second port. Nothing is stubbed inside
 * the app, so a passing run proves the deployment shape ADR 0012 requires:
 * server rendering, metadata, hard 404s, cookie-based auth and no-store private
 * responses on plain Node.js with no Vercel bindings.
 */

const packageDir = new URL("..", import.meta.url).pathname;
const buildEntry = `${packageDir}build/server/index.js`;

let mockApi: MockRestApi;
let app: ChildProcess;
let baseUrl = "";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("Could not reserve a port."));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      await response.text();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`The prototype server did not become ready at ${url}.`);
}

before(async () => {
  assert.ok(
    existsSync(buildEntry),
    "The prototype must be built before its tests run: pnpm --filter @bot-thk/web-rr build",
  );
  mockApi = await startMockRestApi();
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  app = spawn(process.execPath, ["server.ts"], {
    cwd: packageDir,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      HOST: "127.0.0.1",
      API_BASE_URL: mockApi.url,
      // Prove the Vercel-only binding is not required for a working deployment.
      API_SERVICE_URL: "",
      NEXT_PUBLIC_SITE_URL: "https://no-wave.example",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const errors: string[] = [];
  app.stderr?.on("data", (chunk: Buffer) => errors.push(chunk.toString()));
  app.once("exit", (code) => {
    if (code !== 0 && errors.length > 0) process.stderr.write(`web-rr exited ${code}:\n${errors.join("")}`);
  });
  await waitForServer(`${baseUrl}/`);
});

after(async () => {
  await new Promise<void>((resolve) => {
    if (!app || app.exitCode !== null) {
      resolve();
      return;
    }
    app.once("exit", () => resolve());
    app.kill("SIGTERM");
  });
  await mockApi?.close();
});

type Result = { status: number; headers: Headers; body: string };

async function get(pathname: string, headers: Record<string, string> = {}): Promise<Result> {
  const response = await fetch(`${baseUrl}${pathname}`, { headers, redirect: "manual" });
  return { status: response.status, headers: response.headers, body: await response.text() };
}

async function post(pathname: string, body: string, headers: Record<string, string> = {}): Promise<Result> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    body,
    headers: { "content-type": "application/json", origin: baseUrl, ...headers },
    redirect: "manual",
  });
  return { status: response.status, headers: response.headers, body: await response.text() };
}

async function put(pathname: string, body: string, headers: Record<string, string> = {}): Promise<Result> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "PUT",
    body,
    headers: { "content-type": "application/json", origin: baseUrl, ...headers },
    redirect: "manual",
  });
  return { status: response.status, headers: response.headers, body: await response.text() };
}

test("home renders API-backed articles on the server", async () => {
  const result = await get("/");
  assert.equal(result.status, 200);
  assert.match(result.body, /可移植的文学基础设施/);
  // Unique to the mock API: the fixture registry never contains this summary.
  assert.match(result.body, /从框架依赖中取回叙事自主权的实践记录。/);
  // `WorkRow` from apps/web renders its `next/link` through the prototype shim.
  assert.match(result.body, /href="\/articles\/portable-web-foundation"/);
});

test("article route server-renders content, canonical alternates and Open Graph metadata", async () => {
  const result = await get("/articles/portable-web-foundation");
  assert.equal(result.status, 200);
  // The site title suffix comes from the App Router's root layout template
  // (`title.template: "%s | 无浪潮"`); see app/lib/meta.ts.
  assert.match(result.body, /<title>可移植的文学基础设施 | 无浪潮<\/title>/);
  assert.match(result.body, /rel="canonical" href="https:\/\/no-wave\.example\/articles\/portable-web-foundation"/);
  assert.match(result.body, /property="og:title" content="可移植的文学基础设施"/);
  assert.match(result.body, /rel="alternate" hrefLang="zh-CN"/);
  assert.match(result.body, /文字不该与某一家托管|文学网站的命运不该/);
  assert.match(result.body, new RegExp(MOCK_DISPLAY_NAME));
});

test("the English article route renders English content and a localized canonical URL", async () => {
  const result = await get("/en/articles/portable-web-foundation");
  assert.equal(result.status, 200);
  assert.match(result.body, /<html lang="en"/);
  assert.match(result.body, /A Portable Literary Foundation/);
  assert.match(result.body, /href="https:\/\/no-wave\.example\/en\/articles\/portable-web-foundation"/);
});

test("an unknown article is a hard 404, not a soft 404", async () => {
  const result = await get("/articles/does-not-exist");
  assert.equal(result.status, 404);
  assert.match(result.body, /这一页不存在/);
});

test("the sign-in page renders the shared interactive form", async () => {
  const result = await get("/sign-in?next=%2Faccount");
  assert.equal(result.status, 200);
  assert.match(result.body, /name="email"/);
  assert.match(result.body, /name="password"/);
  assert.match(result.body, /进入写作/);
});

test("a successful sign-in stores HttpOnly cookies and never returns tokens in JSON", async () => {
  const result = await post(
    "/api/auth/login",
    JSON.stringify({ email: MOCK_CREDENTIALS.email, password: MOCK_CREDENTIALS.password }),
  );
  assert.equal(result.status, 200);

  const cookies = result.headers.getSetCookie();
  const access = cookies.find((cookie) => cookie.startsWith("nw_access="));
  const refresh = cookies.find((cookie) => cookie.startsWith("nw_refresh="));
  assert.ok(access, "the access cookie must be set");
  assert.ok(refresh, "the refresh cookie must be set");
  assert.match(access, /HttpOnly/);
  assert.match(access, /Path=\/api\/authoring/);
  assert.match(access, /SameSite=Lax/);
  assert.match(refresh, /Path=\/api/);
  // The proxy runs on plain HTTP here, so `Secure` must not be set (it would make
  // the cookie undeliverable in this environment). It is asserted in the handler
  // test instead, where `x-forwarded-proto: https` is sent.
  assert.doesNotMatch(access, /Secure/);

  assert.equal(result.body.includes(MOCK_TOKENS.accessToken), false);
  assert.equal(result.body.includes(MOCK_TOKENS.refreshToken), false);
  assert.match(result.body, /accessExpiresAt/);
});

test("cookies become Secure when the request arrives over TLS", async () => {
  const result = await post(
    "/api/auth/login",
    JSON.stringify({ email: MOCK_CREDENTIALS.email, password: MOCK_CREDENTIALS.password }),
    { "x-forwarded-proto": "https" },
  );
  assert.equal(result.status, 200);
  assert.match(result.headers.getSetCookie().find((cookie) => cookie.startsWith("nw_access=")) ?? "", /Secure/);
});

test("rejected credentials surface the API error without setting cookies", async () => {
  const result = await post("/api/auth/login", JSON.stringify({ email: MOCK_CREDENTIALS.email, password: "wrong-password" }));
  assert.equal(result.status, 401);
  assert.equal(result.headers.getSetCookie().length, 0);
  assert.match(result.body, /INVALID_CREDENTIALS/);
});

test("a cross-origin mutation is rejected before it reaches the API", async () => {
  const result = await post(
    "/api/auth/login",
    JSON.stringify({ email: MOCK_CREDENTIALS.email, password: MOCK_CREDENTIALS.password }),
    { origin: "https://attacker.example" },
  );
  assert.equal(result.status, 403);
  assert.match(result.body, /ORIGIN_REJECTED/);
});

test("a non-JSON body is rejected with 415", async () => {
  const result = await post("/api/auth/login", "email=a", { "content-type": "application/x-www-form-urlencoded" });
  assert.equal(result.status, 415);
  assert.match(result.body, /UNSUPPORTED_MEDIA_TYPE/);
});

test("a signed-out account request redirects instead of rendering an empty page", async () => {
  const result = await get("/account");
  assert.equal(result.status, 302);
  assert.equal(result.headers.get("location"), "/sign-in?next=%2Faccount");
});

test("a signed-in account request is private, no-store and token-free", async () => {
  const result = await get("/account", { cookie: `nw_access=${MOCK_TOKENS.accessToken}` });
  assert.equal(result.status, 200);
  assert.match(result.headers.get("cache-control") ?? "", /no-store/);
  assert.match(result.body, new RegExp(MOCK_DISPLAY_NAME));
  assert.equal(result.body.includes(MOCK_TOKENS.accessToken), false);
});

test("an expired session is treated as signed out", async () => {
  const result = await get("/account", { cookie: "nw_access=stale-token-value" });
  assert.equal(result.status, 302);
  assert.equal(result.headers.get("location"), "/sign-in?next=%2Faccount");
});

test("logout clears both token cookies", async () => {
  const result = await post("/api/auth/logout", "", {
    cookie: `nw_access=${MOCK_TOKENS.accessToken}; nw_refresh=${MOCK_TOKENS.refreshToken}`,
    "content-type": "application/json",
  });
  assert.equal(result.status, 200);
  const cookies = result.headers.getSetCookie();
  assert.ok(cookies.some((cookie) => cookie.startsWith("nw_access=;") && /Max-Age=0/.test(cookie)));
  assert.ok(cookies.some((cookie) => cookie.startsWith("nw_refresh=;") && /Max-Age=0/.test(cookie)));
});

/* ------------------------------------------------------------------ Phase 3 */

/**
 * Public SSR routes migrated in Phase 3: archive, author, category index/detail
 * and search.
 *
 * The assertions are the migration contract, not markup snapshots:
 *
 *   1. server-rendered (the content is in the first response, no JS required);
 *   2. localized by path, with canonical/hreflang metadata;
 *   3. unknown entities are hard 404s;
 *   4. shared caching is allowed only where the HTML is public;
 *   5. each page costs at most **two** API calls — the budget that keeps a
 *      0.1-CPU, cold-starting instance responsive.
 */

async function upstreamCalls(pathname: string): Promise<string[]> {
  mockApi.resetRequests();
  await get(pathname);
  return mockApi.requests().filter((entry) => entry.includes("/api/v1/"));
}

test("archive is server-rendered, localized and shared-cacheable", async () => {
  const result = await get("/articles");
  assert.equal(result.status, 200);
  assert.match(result.body, /可移植的文学基础设施/);
  assert.match(result.body, /rel="canonical" href="https:\/\/no-wave\.example\/articles"/);
  assert.match(result.body, /rel="alternate" hrefLang="en"/);
  assert.match(result.headers.get("cache-control") ?? "", /public/);
  assert.match(result.headers.get("cache-control") ?? "", /s-maxage=60/);
  assert.match(result.headers.get("cache-control") ?? "", /stale-while-revalidate=300/);

  const english = await get("/en/articles");
  assert.equal(english.status, 200);
  assert.match(english.body, /A Portable Literary Foundation/);
  assert.match(english.body, /rel="canonical" href="https:\/\/no-wave\.example\/en\/articles"/);
});

test("archive filters by query and by work type without extra API calls", async () => {
  const matching = await get("/articles?q=抵抗");
  assert.equal(matching.status, 200);
  assert.match(matching.body, /作为抵抗的阅读/);
  assert.doesNotMatch(matching.body, /可移植的文学基础设施/);

  const empty = await get("/articles?q=肯定不存在的关键词");
  assert.equal(empty.status, 200);
  assert.match(empty.body, /没有符合条件的作品/);

  const byType = await get("/articles?type=short_story");
  assert.equal(byType.status, 200);
  assert.match(byType.body, /作为抵抗的阅读/);
  assert.doesNotMatch(byType.body, /可移植的文学基础设施/);
  // Type filtering scans a bounded window and is served by one call.
  assert.equal((await upstreamCalls("/articles?type=short_story")).length, 1);
});

test("author pages render the profile and its catalogue, unknown authors are 404", async () => {
  const result = await get("/authors/writer");
  assert.equal(result.status, 200);
  assert.match(result.body, new RegExp(MOCK_DISPLAY_NAME));
  assert.match(result.body, /可移植的文学基础设施/);
  assert.match(result.body, /rel="canonical" href="https:\/\/no-wave\.example\/authors\/writer"/);

  const missing = await get("/authors/nobody");
  assert.equal(missing.status, 404);
  assert.match(missing.body, /这一页不存在/);
});

test("category index and detail are server-rendered with hard 404s", async () => {
  const index = await get("/categories");
  assert.equal(index.status, 200);
  assert.match(index.body, /随笔/);
  assert.match(index.body, /href="\/categories\/essays"/);

  const detail = await get("/categories/essays");
  assert.equal(detail.status, 200);
  assert.match(detail.body, /可移植的文学基础设施/);

  const english = await get("/en/categories");
  assert.equal(english.status, 200);
  assert.match(english.body, /Essays/);

  const missing = await get("/categories/does-not-exist");
  assert.equal(missing.status, 404);
  assert.match(missing.body, /这一页不存在/);
});

test("search is server-rendered, no-store and excluded from indexing", async () => {
  // Search is locale-scoped, exactly like the App Router page: the query is run
  // against the content in the language of the path.
  const result = await get("/search?q=抵抗");
  assert.equal(result.status, 200);
  assert.match(result.body, /作为抵抗的阅读/);
  assert.doesNotMatch(result.body, /可移植的文学基础设施/);

  const english = await get("/en/search?q=portable");
  assert.equal(english.status, 200);
  assert.match(english.body, /A Portable Literary Foundation/);
  assert.match(result.headers.get("cache-control") ?? "", /no-store/);
  assert.match(result.body, /name="robots" content="noindex, follow"/);

  const empty = await get("/search");
  assert.equal(empty.status, 200);
  assert.match(empty.body, /按类型浏览/);
});

test("every migrated public page spends at most two API calls", async () => {
  const pages = ["/", "/articles", "/articles?q=抵抗", "/authors/writer", "/categories", "/categories/essays", "/search?q=portable"];
  for (const pathname of pages) {
    const calls = await upstreamCalls(pathname);
    assert.ok(calls.length >= 1, `${pathname} must read content from the API, not fixtures`);
    assert.ok(calls.length <= 2, `${pathname} exceeded the two-call budget: ${calls.join(", ")}`);
  }
});

/* --------------------------------------------------- Phase 5a: media adapter */

/**
 * Media relayed through the app rather than the bucket.
 *
 * The storage credentials stay in the API; what is asserted here is what the
 * browser is allowed to see — immutable caching keyed on a content hash, 304
 * revalidation, a locked-down content type, and an upload path that rejects
 * cross-origin and non-image requests before buffering anything.
 */
test("a media object is relayed with immutable caching and its content-hash ETag", async () => {
  const result = await get(`/api/media/${MOCK_MEDIA.id}`);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("content-type"), "image/webp");
  assert.match(result.headers.get("cache-control") ?? "", /public, max-age=31536000, immutable/);
  assert.equal(result.headers.get("etag"), MOCK_MEDIA.etag);
  assert.equal(result.headers.get("x-content-type-options"), "nosniff");
  assert.equal(result.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.equal(Number(result.headers.get("content-length")), MOCK_MEDIA.bytes.byteLength);
});

test("a conditional media request is answered with 304 and no body", async () => {
  const result = await get(`/api/media/${MOCK_MEDIA.id}`, { "if-none-match": MOCK_MEDIA.etag });
  assert.equal(result.status, 304);
  assert.equal(result.headers.get("etag"), MOCK_MEDIA.etag);
  assert.equal(result.body, "");
});

test("an unknown or malformed media id is a 404 that never reaches the API", async () => {
  mockApi.resetRequests();
  for (const pathname of ["/api/media/not-a-uuid", `/api/media/${"0".repeat(8)}-0000-0000-0000-000000000000`]) {
    const result = await get(pathname);
    assert.equal(result.status, 404);
    assert.match(result.body, /NOT_FOUND/);
  }
  assert.deepEqual(mockApi.requests(), []);
});

test("media uploads are origin-checked, type-checked and authenticated", async () => {
  const crossOrigin = await post("/api/authoring/media", "x".repeat(32), {
    origin: "https://attacker.example",
    "content-type": "image/png",
  });
  assert.equal(crossOrigin.status, 403);
  assert.match(crossOrigin.body, /ORIGIN_REJECTED/);

  const wrongType = await post("/api/authoring/media", "x".repeat(32), { "content-type": "text/html" });
  assert.equal(wrongType.status, 415);
  assert.match(wrongType.body, /UNSUPPORTED_MEDIA_TYPE/);

  const anonymous = await post("/api/authoring/media", "x".repeat(32), { "content-type": "image/png" });
  assert.equal(anonymous.status, 401);

  const signedIn = await post("/api/authoring/media", "x".repeat(32), {
    "content-type": "image/png",
    cookie: `nw_access=${MOCK_TOKENS.accessToken}`,
  });
  assert.equal(signedIn.status, 201);
  assert.match(signedIn.body, new RegExp(MOCK_MEDIA.id));
  assert.match(signedIn.headers.get("cache-control") ?? "", /no-store/);
});

/* ------------------------------------------------ Phase 3: home, sitemap, robots */

test("home is server-rendered from the shared home view for both locales", async () => {
  const result = await get("/");
  assert.equal(result.status, 200);
  // The hero, the selected triptych and the topic row are all in the first
  // response: no client-side navigation is required to see the page.
  assert.match(result.body, /data-hero/);
  assert.match(result.body, /nw-tri/);
  assert.match(result.body, /id="topics"/);
  assert.match(result.body, /可移植的文学基础设施/);
  assert.match(result.body, /href="\/articles\/portable-web-foundation"/);
  // The App Router resolves the site root to the bare origin (no trailing
  // slash); `routerUrl()` in app/lib/meta.ts mirrors it so both emit the same
  // bytes. The hreflang target is asserted too — a link that announces `zh-CN`
  // and points somewhere else is a real SEO bug.
  assert.match(result.body, /rel="canonical" href="https:\/\/no-wave\.example"\/>/);
  assert.match(result.body, /rel="alternate" hrefLang="zh-CN" href="https:\/\/no-wave\.example"\/>/);
  assert.match(result.body, /rel="alternate" hrefLang="en" href="https:\/\/no-wave\.example\/en"\/>/);
  assert.match(result.headers.get("cache-control") ?? "", /s-maxage=60/);

  const english = await get("/en");
  assert.equal(english.status, 200);
  assert.match(english.body, /<html lang="en"/);
  assert.match(english.body, /A Portable Literary Foundation/);
  assert.match(english.body, /rel="canonical" href="https:\/\/no-wave\.example\/en"/);
});

test("sitemap.xml lists both locales and robots.txt points at it", async () => {
  const sitemap = await get("/sitemap.xml");
  assert.equal(sitemap.status, 200);
  assert.match(sitemap.headers.get("content-type") ?? "", /application\/xml/);
  assert.match(sitemap.body, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.match(sitemap.body, /<loc>https:\/\/no-wave\.example\/<\/loc>/);
  assert.match(sitemap.body, /<loc>https:\/\/no-wave\.example\/en\/articles<\/loc>/);
  assert.match(sitemap.body, /<loc>https:\/\/no-wave\.example\/authors\/writer<\/loc>/);
  assert.match(sitemap.body, /<loc>https:\/\/no-wave\.example\/en\/articles\/portable-web-foundation<\/loc>/);
  // Shared-cacheable: crawlers hit it repeatedly and it is expensive to build.
  assert.match(sitemap.headers.get("cache-control") ?? "", /s-maxage/);

  const robots = await get("/robots.txt");
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get("content-type") ?? "", /text\/plain/);
  assert.match(robots.body, /User-Agent: \*/);
  assert.match(robots.body, /Sitemap: https:\/\/no-wave\.example\/sitemap\.xml/);
});

test("page titles carry the App Router's site suffix, and the root page does not", async () => {
  // The App Router applies `title.template` to descendant segments only, so `/`
  // is served with the bare home title while `/en` carries the suffix. Both
  // spellings are asserted here because they are what search engines see.
  const home = await get("/");
  assert.match(home.body, /<title>以文学作品为中心，构建独立的数字出版空间<\/title>/);

  const englishHome = await get("/en");
  assert.match(englishHome.body, /<title>A home for serious literature | 无浪潮<\/title>/);

  // Strings taken from app/search/page.tsx and app/en/search/page.tsx.
  const search = await get("/search?q=抵抗");
  assert.match(search.body, /<title>搜索 | 无浪潮<\/title>/);

  const englishSearch = await get("/en/search?q=portable");
  assert.match(englishSearch.body, /<title>Search | 无浪潮<\/title>/);

  const categories = await get("/categories");
  assert.match(categories.body, /<title>作品分类 | 无浪潮<\/title>/);
});

test("a missing public entity is a hard 404 that is titled, no-store and noindex", async () => {
  for (const pathname of ["/articles/does-not-exist", "/authors/nobody", "/categories/does-not-exist"]) {
    const result = await get(pathname);
    assert.equal(result.status, 404, `${pathname} must be a hard 404`);
    // A crawler must see a page that says what happened, and must not be given
    // a copy that a shared cache is allowed to keep.
    assert.match(result.body, /<title>404 | 无浪潮<\/title>/, `${pathname} needs a title`);
    assert.match(result.body, /name="robots" content="noindex, nofollow"/);
    assert.match(result.headers.get("cache-control") ?? "", /no-store/, `${pathname} must not be cached`);
  }
});

/* ------------------------------------ Phase 4a: comments, the page after hydration */

/**
 * A page can be perfectly server-rendered and still be dead: `ArticleComments`
 * renders in both frameworks, but until this slice the prototype had no
 * `/api/articles/:slug/comments` route at all, so the component had nothing to
 * talk to. These assertions cover the endpoint the component calls — including
 * the two rules that make it a mutation proxy rather than an open relay.
 */
test("the comment thread the component fetches is served, no-store and API-backed", async () => {
  const result = await get("/api/articles/portable-web-foundation/comments?locale=zh-CN");
  assert.equal(result.status, 200);
  assert.match(result.headers.get("cache-control") ?? "", /no-store/);
  const payload = JSON.parse(result.body) as {
    data: { id: string; body: string; author: { displayName: string } }[];
  };
  assert.equal(payload.data[0]?.id, MOCK_COMMENT_ID);
  assert.match(payload.data[0]?.body ?? "", /托管成本/);
  assert.equal(payload.data[0]?.author.displayName, MOCK_DISPLAY_NAME);
  // The page limit is part of the shared contract, not a per-framework detail.
  assert.ok(
    mockApi.requests().some((request) => request.includes("limit=50")),
    `the upstream call must carry the documented page limit: ${mockApi.requests().join(", ")}`,
  );
});

test("a malformed slug is a local 400 that never reaches the API", async () => {
  mockApi.resetRequests();
  const result = await get("/api/articles/Not_A_Slug/comments");
  assert.equal(result.status, 400);
  assert.deepEqual(mockApi.requests(), [], "an invalid slug must be rejected before proxying");
});

test("posting a comment requires our own origin and a session", async () => {
  const path = "/api/articles/portable-web-foundation/comments?locale=zh-CN";

  mockApi.resetRequests();
  const crossOrigin = await post(path, JSON.stringify({ body: "好" }), { origin: "https://evil.test" });
  assert.equal(crossOrigin.status, 403);
  assert.deepEqual(mockApi.requests(), [], "a cross-origin write must not be forwarded at all");

  const anonymous = await post(path, JSON.stringify({ body: "好" }));
  assert.equal(anonymous.status, 401, "the API's own refusal is forwarded, not replaced by fixtures");

  const signedIn = await post(path, JSON.stringify({ body: "值得一读" }), {
    cookie: `nw_access=${MOCK_TOKENS.accessToken}`,
  });
  assert.equal(signedIn.status, 201);
  const created = JSON.parse(signedIn.body) as { data: { body: string } };
  assert.equal(created.data.body, "值得一读");
});

/**
 * The article page's interactive parts are part of the page, not of a later
 * phase: the reader toolbar, the table of contents and the comment section are
 * client components, and the comment section is only useful together with the
 * endpoint it calls. They are asserted in the server-rendered HTML (the mount
 * points) and in the client bundle (`client-bundle.test.ts`, the code that
 * hydrates them) — the two halves that together mean "this will work in a
 * browser".
 */
test("the article page renders the reader toolbar, the table of contents and the comment section", async () => {
  const result = await get("/articles/portable-web-foundation");
  assert.equal(result.status, 200);
  // ReaderBar: font size, paper/ink and copy-link controls.
  assert.match(result.body, /class="nw-rs" role="group"/);
  // ReadingProgress measures this element; ReaderToc links to its headings.
  assert.match(result.body, /id="nw-article"/);
  assert.match(result.body, /class="nw-toc"/);
  // ArticleComments: the section, and the composer that posts to the proxy above.
  assert.match(result.body, /class="nw-comment-section"/);
  assert.match(result.body, /nw-comment-editor/);
});

/**
 * The writing desk (Phase 4b).
 *
 * `AuthoringWorkspace` is a shared client component, so the desk renders in both
 * frameworks — what it needs from the framework is the API it calls. These tests
 * drive that API over real HTTP against the production build: a signed-out desk
 * must be told it is signed out, a signed-in one must be able to read its own
 * work, and writing twice must update one article rather than create two.
 */
const DESK_COOKIE = `nw_access=${MOCK_TOKENS.accessToken}`;

function editorStateOf(text: string): unknown {
  return {
    root: {
      children: [
        {
          children: [{ detail: 0, format: 0, mode: "normal", style: "", text, type: "text", version: 1 }],
          direction: "ltr",
          format: "",
          indent: 0,
          type: "paragraph",
          version: 1,
        },
      ],
      direction: "ltr",
      format: "",
      indent: 0,
      type: "root",
      version: 1,
    },
  };
}

function articleBody(title: string, publish = false): string {
  return JSON.stringify({
    title,
    summary: "",
    locale: "zh-CN",
    workType: "essay",
    editorState: editorStateOf(`${title} 的第一段，用来验证保存链路。`),
    contentBlocksVersion: 1,
    publish,
  });
}

test("the writing desk renders its shared client component, privately", async () => {
  const result = await get("/write");
  assert.equal(result.status, 200);
  assert.match(result.body, /data-route="write"/);
  // The desk's own first line: the shared workspace is rendered here, not a
  // reduced stand-in, and it is the client component that draws the rest.
  assert.match(result.body, /正在验证登录状态并载入草稿/);
  assert.match(result.headers.get("cache-control") ?? "", /no-store/);
  assert.match(result.body, /noindex/);
});

test("a signed-out desk is told it is signed out, not handed an error page", async () => {
  const result = await get("/api/authoring/session");
  assert.equal(result.status, 401);
  assert.match(result.headers.get("cache-control") ?? "", /no-store/);
});

test("a signed-in desk reads its session and its own work", async () => {
  const session = await get("/api/authoring/session", { cookie: DESK_COOKIE });
  assert.equal(session.status, 200);
  assert.match(session.body, new RegExp(MOCK_DISPLAY_NAME));
  assert.match(session.headers.get("cache-control") ?? "", /no-store/);

  const list = await get("/api/authoring/articles", { cookie: DESK_COOKIE });
  assert.equal(list.status, 200);
  assert.match(list.headers.get("cache-control") ?? "", /no-store/);
  // Seeded from the catalogue, so the desk lists what this author published.
  assert.match(list.body, /可移植的文学基础设施/);
});

test("the desk creates a work, and it shows up in the author's list", async () => {
  const created = await post("/api/authoring/articles", articleBody("Desk Draft Alpha"), { cookie: DESK_COOKIE });
  assert.equal(created.status, 201);
  const article = (JSON.parse(created.body) as { data: { slug: string; status: string } }).data;
  assert.equal(article.slug, "desk-draft-alpha", "the address is derived, not supplied");
  assert.equal(article.status, "draft");

  const list = await get("/api/authoring/articles", { cookie: DESK_COOKIE });
  assert.match(list.body, /Desk Draft Alpha/);
});

test("saving the same work again updates it instead of creating a second one", async () => {
  const created = await post("/api/authoring/articles", articleBody("Desk Draft Beta"), { cookie: DESK_COOKIE });
  assert.equal(created.status, 201);
  const { id } = (JSON.parse(created.body) as { data: { id: string } }).data;

  const updated = await put(`/api/authoring/articles/${id}`, articleBody("Desk Draft Beta", true), { cookie: DESK_COOKIE });
  assert.equal(updated.status, 200);
  const article = (JSON.parse(updated.body) as { data: { id: string; status: string } }).data;
  assert.equal(article.id, id, "the update must address the same article");
  assert.equal(article.status, "published");

  const list = await get("/api/authoring/articles", { cookie: DESK_COOKIE });
  assert.equal((list.body.match(/desk-draft-beta/g) ?? []).length, 1, "a second save must not duplicate the work");
});

test("a published work can be withdrawn to a draft again", async () => {
  const created = await post("/api/authoring/articles", articleBody("Desk Withdraw Gamma"), { cookie: DESK_COOKIE });
  assert.equal(created.status, 201);
  const { id } = (JSON.parse(created.body) as { data: { id: string } }).data;

  const published = await put(`/api/authoring/articles/${id}`, articleBody("Desk Withdraw Gamma", true), { cookie: DESK_COOKIE });
  assert.equal((JSON.parse(published.body) as { data: { status: string } }).data.status, "published");

  // The desk's 转为草稿 is the same PUT with `publish: false`; nothing new was
  // added to the contract, so this is the prototype proving the seam carries
  // the intent rather than the framework.
  const withdrawn = await put(`/api/authoring/articles/${id}`, articleBody("Desk Withdraw Gamma", false), { cookie: DESK_COOKIE });
  assert.equal(withdrawn.status, 200);
  const article = (JSON.parse(withdrawn.body) as { data: { id: string; status: string; publishedAt: string | null } }).data;
  assert.equal(article.id, id, "withdrawing must address the same work, not create another");
  assert.equal(article.status, "draft");
  assert.equal(article.publishedAt, null, "a withdrawn work has no publication date");

  // Withdrawn, not lost: it is still the author's own work.
  const list = await get("/api/authoring/articles", { cookie: DESK_COOKIE });
  assert.match(list.body, /Desk Withdraw Gamma/);
});

test("the desk's writes are origin-checked, and the origin check comes first", async () => {
  const cross = await post("/api/authoring/articles", articleBody("Cross Origin"), {
    cookie: DESK_COOKIE,
    origin: "https://attacker.example",
  });
  assert.equal(cross.status, 403);
  assert.match(cross.body, /ORIGIN_REJECTED/);

  const malformed = await put("/api/authoring/articles/not-a-uuid", "{}", { cookie: DESK_COOKIE });
  assert.equal(malformed.status, 400);
  assert.match(malformed.body, /BAD_USER_INPUT/);

  // Order: a cross-origin request must be refused for its origin, so it cannot
  // use the status code to learn whether the id it guessed exists.
  const both = await put("/api/authoring/articles/not-a-uuid", "{}", {
    cookie: DESK_COOKIE,
    origin: "https://attacker.example",
  });
  assert.equal(both.status, 403);
});


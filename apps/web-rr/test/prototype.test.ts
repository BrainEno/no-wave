import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import { MOCK_CREDENTIALS, MOCK_DISPLAY_NAME, MOCK_MEDIA, MOCK_TOKENS, startMockRestApi } from "../mocks/rest-api.ts";
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
  assert.match(result.body, /<title>可移植的文学基础设施<\/title>/);
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

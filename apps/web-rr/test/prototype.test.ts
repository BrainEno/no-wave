import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import {
  MOCK_COMMENT_ID,
  MOCK_CREDENTIALS,
  MOCK_DELETED_ARTICLE_ID,
  MOCK_DISPLAY_NAME,
  MOCK_MEDIA,
  MOCK_NOTIFICATION,
  MOCK_TOKENS,
  resetMockNotifications,
  startMockRestApi,
} from "../mocks/rest-api.ts";
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

async function del(pathname: string, headers: Record<string, string> = {}): Promise<Result> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "DELETE",
    headers: { origin: baseUrl, ...headers },
    redirect: "manual",
  });
  return { status: response.status, headers: response.headers, body: await response.text() };
}

/** A write with no body at all, which is what restoring a work is. */
async function postEmpty(pathname: string, headers: Record<string, string> = {}): Promise<Result> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { origin: baseUrl, ...headers },
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

/**
 * The site shell — navigation, language switch, notification panel, footer —
 * used to be absent here: `root.tsx` rendered `<Outlet />` and nothing else,
 * while the App Router renders the shared `SiteChrome` from its root layout.
 *
 * Nothing else in this file could see that. A page with no navigation still has
 * a status, a title, a canonical URL and its content, so every one of those
 * assertions passes on a page the visitor cannot leave. `pnpm check:ssr-parity`
 * could not see it either until its shell markers became absolute: comparing
 * the two implementations only proves they agree, and they agreed on the
 * omission.
 */
test("every page carries the site shell, including a dead link", async () => {
  const home = await get("/");
  assert.equal(home.status, 200);
  assert.match(home.body, /class="nw-pill"/, "the top navigation is part of the page");
  assert.match(home.body, /class="nw-footer"/, "so is the footer");
  assert.match(home.body, /href="\/account"/, "the account entry lives in the shell, not in a page");
  assert.match(home.body, /href="\/write"/);
  assert.match(home.body, /href="\/search"/);
  // The language switch is the shell's own logic: on a Chinese page the EN link
  // leads to the English route, and the pair is rendered in both directions.
  assert.match(home.body, /href="\/en"/);

  const english = await get("/en");
  assert.equal(english.status, 200);
  assert.match(english.body, /class="nw-pill"/);
  assert.match(english.body, /class="nw-footer"/);
  // 简 on an English page leads back to the Chinese route, not to a dead end.
  assert.match(english.body, /href="\/"/);

  // The page a visitor most needs a way out of. The App Router renders its
  // not-found page inside the root layout, so this one has to as well.
  const missing = await get("/articles/does-not-exist");
  assert.equal(missing.status, 404);
  assert.match(missing.body, /class="nw-pill"/, "a 404 must still offer the navigation");
  assert.match(missing.body, /class="nw-footer"/);
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

/**
 * The account page is private, but the token cookies are scoped below `/` — so
 * the render cannot read them and must not try. What it reads instead is the
 * session marker, whose only claim is "the session can still be renewed".
 *
 * The consequence the assertions pin down: the HTML is a shell. No address, no
 * token and no account data are in it, because all of that is resolved by the
 * browser from `/api/authoring/session`, which is the request that can present
 * the access token to the API.
 */
test("a live session marker opens a private, no-store, data-free account shell", async () => {
  const result = await get("/account", { cookie: `nw_session=${Math.floor((Date.now() + 3_600_000) / 1000)}` });
  assert.equal(result.status, 200);
  assert.match(result.headers.get("cache-control") ?? "", /no-store/);
  assert.match(result.body, /我的账户/);
  assert.equal(result.body.includes(MOCK_TOKENS.accessToken), false);
  assert.equal(result.body.includes(MOCK_CREDENTIALS.email), false, "no address in the HTML: the shell is filled by the browser");
});

test("an expired session is treated as signed out", async () => {
  const result = await get("/account", { cookie: `nw_session=${Math.floor((Date.now() - 1_000) / 1000)}` });
  assert.equal(result.status, 302);
  assert.equal(result.headers.get("location"), "/sign-in?next=%2Faccount");
});

test("a marker that does not parse is treated as signed out", async () => {
  for (const value of ["soon", "", "0", "-1", `${Math.floor(Date.now() / 1000)}.5`]) {
    const result = await get("/account", { cookie: `nw_session=${value}` });
    assert.equal(result.status, 302, `marker ${JSON.stringify(value)} must not open the page`);
  }
  // The token cookies are deliberately invisible to a page render: presenting
  // one here is not a session as far as the route is concerned.
  const withToken = await get("/account", { cookie: `nw_access=${MOCK_TOKENS.accessToken}` });
  assert.equal(withToken.status, 302);
});

test("logout clears every session cookie, including the marker", async () => {
  const result = await post("/api/auth/logout", "", {
    cookie: `nw_access=${MOCK_TOKENS.accessToken}; nw_refresh=${MOCK_TOKENS.refreshToken}`,
    "content-type": "application/json",
  });
  assert.equal(result.status, 200);
  const cookies = result.headers.getSetCookie();
  assert.ok(cookies.some((cookie) => cookie.startsWith("nw_access=;") && /Max-Age=0/.test(cookie)));
  assert.ok(cookies.some((cookie) => cookie.startsWith("nw_refresh=;") && /Max-Age=0/.test(cookie)));
  // The marker is what a page render reads: leaving it behind would keep private
  // pages rendering for a session the API has already refused.
  assert.ok(cookies.some((cookie) => cookie.startsWith("nw_session=;") && /Max-Age=0/.test(cookie)));

  const after = await get("/account", { cookie: `nw_session=${Math.floor((Date.now() + 3_600_000) / 1000)}` });
  assert.equal(after.status, 200, "the marker is set by a session, not by this request");
});

test("sign-in sets the session marker the account page reads", async () => {
  const result = await post(
    "/api/auth/login",
    JSON.stringify({ email: MOCK_CREDENTIALS.email, password: MOCK_CREDENTIALS.password }),
  );
  const marker = result.headers.getSetCookie().find((cookie) => cookie.startsWith("nw_session="));
  assert.ok(marker, "the marker must be set with the tokens");
  assert.match(marker, /Path=\//, "a page render can only read a cookie scoped to /");
  assert.match(marker, /HttpOnly/);
  assert.match(marker, /SameSite=Lax/);
  const value = marker.slice("nw_session=".length, marker.indexOf(";"));
  assert.match(value, /^\d+$/, "the marker carries an expiry, never a credential");
});

/**
 * Boot the same build on another port with `MAIL_ENABLED=true`.
 *
 * The switch is read at request time, so flipping it must not require a rebuild
 * — and this is the assertion that says so, over HTTP, against the production
 * build. The suite's own server runs without the variable, which is the default.
 */
async function withMailEnabledServer(run: (url: string) => Promise<void>): Promise<void> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.ts"], {
    cwd: packageDir,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      HOST: "127.0.0.1",
      API_BASE_URL: mockApi.url,
      API_SERVICE_URL: "",
      NEXT_PUBLIC_SITE_URL: "https://no-wave.example",
      MAIL_ENABLED: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForServer(`${url}/`);
    await run(url);
  } finally {
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) { resolve(); return; }
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    });
  }
}

test("the sign-in form offers recovery only while mail is switched on", async () => {
  // The suite's server runs with mail off, which is the product default.
  const off = await get("/sign-in");
  assert.equal(off.status, 200);
  assert.equal(off.body.includes("/forgot-password"), false, "no recovery link when no recovery mail can be sent");
  assert.match(off.body, /name="password"/, "the form itself is unchanged");

  await withMailEnabledServer(async (url) => {
    const response = await fetch(`${url}/sign-in`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /\/forgot-password/, "the same build offers the link once the switch is on");
  });
});

/**
 * The account page with the switch in both positions.
 *
 * The panel resolves in the browser, so what the switch changes there is a
 * client-side decision — the honest HTTP-level assertions are that the shell is
 * private and mail-free either way, and that turning mail on does not change who
 * can open the page. The server-rendered half of the switch is asserted on the
 * sign-in page above.
 */
test("the account shell is private and mail-free whichever way the switch sits", async () => {
  const marker = `nw_session=${Math.floor((Date.now() + 3_600_000) / 1000)}`;

  const off = await get("/account", { cookie: marker });
  assert.equal(off.status, 200);
  assert.match(off.headers.get("cache-control") ?? "", /no-store/);
  assert.equal(off.body.includes("发送验证邮件"), false, "no mail action is rendered before the session resolves");
  assert.equal(off.body.includes(MOCK_CREDENTIALS.email), false);

  await withMailEnabledServer(async (url) => {
    const response = await fetch(`${url}/account`, { headers: { cookie: marker } });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /我的账户/);
    assert.equal(body.includes("发送验证邮件"), false);
    assert.equal(body.includes(MOCK_CREDENTIALS.email), false);
  });
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

/**
 * Recovery and verification (ADR 0014), in both positions of the switch.
 *
 * The pages exist either way, because "this site cannot send mail" is an answer
 * a visitor is owed, not an error page. What changes is whether they offer a
 * form: with mail off there is no point collecting an address for a link that
 * cannot be sent, and the API would answer `409 MAIL_DISABLED` anyway.
 *
 * The switched-on half runs against the **same production build** on a second
 * port, so these assertions also pin the property that matters operationally:
 * the switch is read per request and needs no rebuild.
 */
test("with mail off the three recovery pages say so instead of collecting an address", async () => {
  for (const path of ["/forgot-password", "/reset-password", "/verify-email"]) {
    const result = await get(path);
    assert.equal(result.status, 200, `${path} must render, not 500 or 404`);
    assert.match(result.body, /未启用邮件功能/, `${path} must name the reason`);
    assert.match(
      result.headers.get("cache-control") ?? "",
      /no-store/,
      `${path} must never be held by a shared cache`,
    );
  }
  // The one that would otherwise collect an address for a mail that cannot be
  // sent. The other two collect a password and a token respectively; they are
  // rendered by the same notice, so this assertion covers the shape.
  const forgot = await get("/forgot-password");
  assert.doesNotMatch(forgot.body, /name="email"/);
  assert.doesNotMatch(forgot.body, /发送重设链接/);
});

test("with mail on the three recovery pages offer the forms, and the switch needs no rebuild", async () => {
  await withMailEnabledServer(async (url) => {
    // `get()` is bound to the shared server; this one has its own origin.
    const page = async (path: string): Promise<{ status: number; body: string }> => {
      const response = await fetch(`${url}${path}`, { redirect: "manual" });
      return { status: response.status, body: await response.text() };
    };

    const forgot = await page("/forgot-password");
    assert.equal(forgot.status, 200);
    assert.match(forgot.body, /发送重设链接/, "the recovery form is offered");
    assert.match(forgot.body, /name="email"/);
    assert.doesNotMatch(forgot.body, /未启用邮件功能/);

    // A link carries a token in the query string; the page renders the form
    // that will spend it, server-side, instead of a notice about mail.
    const reset = await page(`/reset-password?token=${"a".repeat(43)}`);
    assert.equal(reset.status, 200);
    assert.match(reset.body, /确认新密码/);
    assert.doesNotMatch(reset.body, /未启用邮件功能/);

    // A verification link without a token says so, and still no notice: mail is
    // on, the link is simply incomplete.
    const verify = await page("/verify-email");
    assert.equal(verify.status, 200);
    assert.match(verify.body, /链接不完整/);
    assert.doesNotMatch(verify.body, /未启用邮件功能/);
  });
});

test("the recovery endpoints are served by this app's auth resource route", async () => {
  // The handler behind `/api/auth/:action` is shared with the App Router
  // (`handleIdentityAction` in `@bot-thk/web-http`, covered by its own contract
  // tests). What is asserted here is the wiring: this app's route table reaches
  // it, and the action name becomes the upstream path.
  const sent = await post("/api/auth/forgot-password", JSON.stringify({ email: "writer@example.test" }));
  assert.equal(sent.status, 202, "the upstream status is preserved, not flattened to 200");
  assert.match(sent.body, /"ok":true/);
  assert.equal(sent.headers.get("set-cookie"), null, "these actions carry no session");

  const redeemed = await post("/api/auth/reset-password", JSON.stringify({ token: "a".repeat(43), password: "a-long-enough-password" }));
  assert.equal(redeemed.status, 200);
  assert.match(redeemed.body, /"ok":true/);

  // A cross-origin mutation is refused before the API is called, exactly as it
  // is for login: this is the endpoint anyone would automate.
  const crossOrigin = await post("/api/auth/forgot-password", JSON.stringify({ email: "writer@example.test" }), { origin: "https://evil.test" });
  assert.equal(crossOrigin.status, 403);
  assert.match(crossOrigin.body, /ORIGIN_REJECTED/);
});

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
  // The account, as `GET /api/v1/me` answers it: an id, an address and a
  // verification state. The display name is not part of it, and the desk never
  // asked for one.
  assert.match(session.body, /"email"/);
  assert.match(session.body, /"emailVerifiedAt"/);
  assert.equal(session.body.includes(MOCK_TOKENS.accessToken), false);
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

test("a work can be deleted, and it leaves the author's list", async () => {
  const created = await post("/api/authoring/articles", articleBody("Desk Delete Delta"), { cookie: DESK_COOKIE });
  assert.equal(created.status, 201);
  const { id } = (JSON.parse(created.body) as { data: { id: string } }).data;

  const published = await put(`/api/authoring/articles/${id}`, articleBody("Desk Delete Delta", true), { cookie: DESK_COOKIE });
  assert.equal((JSON.parse(published.body) as { data: { status: string } }).data.status, "published");

  const deleted = await del(`/api/authoring/articles/${id}`, { cookie: DESK_COOKIE });
  assert.equal(deleted.status, 200);
  assert.match(deleted.body, /deletedAt/);

  // Deleted, not hidden: the desk's own list is the author's only view of it.
  const list = await get("/api/authoring/articles", { cookie: DESK_COOKIE });
  assert.doesNotMatch(list.body, /Desk Delete Delta/);

  // The desk's delete is origin-checked and authenticated like every other write.
  const cross = await del(`/api/authoring/articles/${id}`, { cookie: DESK_COOKIE, origin: "https://attacker.example" });
  assert.equal(cross.status, 403);
  assert.match(cross.body, /ORIGIN_REJECTED/);
  const anonymous = await del(`/api/authoring/articles/${id}`);
  assert.equal(anonymous.status, 401);
});

test("a deleted work can be restored from the recycle bin, as a draft", async () => {
  const created = await post("/api/authoring/articles", articleBody("Desk Restore Epsilon"), { cookie: DESK_COOKIE });
  assert.equal(created.status, 201);
  const { id, slug } = (JSON.parse(created.body) as { data: { id: string; slug: string } }).data;

  const published = await put(`/api/authoring/articles/${id}`, articleBody("Desk Restore Epsilon", true), { cookie: DESK_COOKIE });
  assert.equal((JSON.parse(published.body) as { data: { status: string } }).data.status, "published");

  // A reader's words, written before the deletion. The sweep will remove them
  // with the work, so the recycle bin counts them rather than staying silent.
  const comment = await post(`/api/articles/${slug}/comments`, JSON.stringify({ body: "值得一读" }), {
    cookie: `nw_access=${MOCK_TOKENS.accessToken}`,
  });
  assert.equal(comment.status, 201);
  await del(`/api/authoring/articles/${id}`, { cookie: DESK_COOKIE });

  // The recycle bin is where the work went: the author's to find, carrying both
  // the moment it was deleted and the moment the sweep will make that permanent.
  const trash = await get("/api/authoring/deleted-articles", { cookie: DESK_COOKIE });
  assert.equal(trash.status, 200);
  const trashed = (JSON.parse(trash.body) as { data: Array<{ id: string; deletedAt: string; purgesAt: string; commentCount: number }> }).data;
  const entry = trashed.find((item) => item.id === id);
  assert.ok(entry, "a deleted work is in the recycle bin, not nowhere");
  assert.ok(entry.deletedAt);
  assert.equal(entry.commentCount, 1, "the sweep takes the comments with it, so the row must say how many");
  assert.ok(new Date(entry.purgesAt).getTime() > new Date(entry.deletedAt).getTime(), "the expiry follows the deletion");

  const restored = await postEmpty(`/api/authoring/articles/${id}/restore`, { cookie: DESK_COOKIE });
  assert.equal(restored.status, 200);
  const restoredData = (JSON.parse(restored.body) as { data: { id: string; status: string; slug: string } }).data;
  assert.equal(restoredData.id, id);
  // A restore must not republish: deleting withdrew the work, and putting it
  // back is the author's decision to make again.
  assert.equal(restoredData.status, "draft");
  assert.equal(restoredData.slug, slug, "the address the deletion released comes back with it");

  const list = await get("/api/authoring/articles", { cookie: DESK_COOKIE });
  assert.match(list.body, /Desk Restore Epsilon/);
  const afterTrash = await get("/api/authoring/deleted-articles", { cookie: DESK_COOKIE });
  assert.doesNotMatch(afterTrash.body, new RegExp(id));

  // A work that is not a tombstone cannot be restored, and the recycle bin and
  // the restore are as authenticated and origin-checked as every desk write.
  const again = await postEmpty(`/api/authoring/articles/${id}/restore`, { cookie: DESK_COOKIE });
  assert.equal(again.status, 404);
  const anonymousRestore = await postEmpty(`/api/authoring/articles/${id}/restore`);
  assert.equal(anonymousRestore.status, 401);
  const cross = await postEmpty(`/api/authoring/articles/${id}/restore`, { cookie: DESK_COOKIE, origin: "https://attacker.example" });
  assert.equal(cross.status, 403);
  assert.match(cross.body, /ORIGIN_REJECTED/);
  const anonymousTrash = await get("/api/authoring/deleted-articles");
  assert.equal(anonymousTrash.status, 401);
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

/**
 * The notification inbox.
 *
 * Deleting a work eventually deletes the comments under it, and those are other
 * people's words, so the API writes each commenter a notice naming the date the
 * sweep runs. A notice nobody can read is a ledger entry rather than a message,
 * and this is where it becomes readable: the same four endpoints, served by the
 * same shared handler, in both frameworks.
 */
test("the inbox is private, no-store and API-backed", async () => {
  const anonymous = await get("/api/authoring/notifications");
  assert.equal(anonymous.status, 401, "an inbox belongs to a signed-in reader");

  mockApi.resetRequests();
  const list = await get("/api/authoring/notifications", { cookie: DESK_COOKIE });
  assert.equal(list.status, 200);
  // An inbox a shared cache could keep would be a privacy bug, not a win.
  assert.match(list.headers.get("cache-control") ?? "", /no-store/);
  const notices = (JSON.parse(list.body) as { data: Array<{ id: string; payload: string }> }).data;
  assert.equal(notices[0]?.id, MOCK_NOTIFICATION.id);
  // The payload is a JSON string on the wire, and what it carries is the two
  // facts the reader can act on: which work, and when the sweep runs.
  assert.deepEqual(JSON.parse(notices[0]?.payload ?? "{}"), {
    type: "article.deleted",
    articleId: MOCK_DELETED_ARTICLE_ID,
    purgesAt: (JSON.parse(MOCK_NOTIFICATION.payload) as { purgesAt: string }).purgesAt,
  });
  assert.ok(
    mockApi.requests().some((request) => request.includes("limit=50")),
    `the upstream call must carry the documented page limit: ${mockApi.requests().join(", ")}`,
  );
});

test("marking a notice read, one at a time or all at once, is the API's own answer", async () => {
  resetMockNotifications();
  const unread = await get("/api/authoring/notifications/unread-count", { cookie: DESK_COOKIE });
  assert.equal((JSON.parse(unread.body) as { data: number }).data, 1);

  const marked = await put(`/api/authoring/notifications/${MOCK_NOTIFICATION.id}/read`, "{}", { cookie: DESK_COOKIE });
  assert.equal(marked.status, 200);
  assert.ok((JSON.parse(marked.body) as { data: { readAt: string | null } }).data.readAt);

  const after = await get("/api/authoring/notifications/unread-count", { cookie: DESK_COOKIE });
  assert.equal((JSON.parse(after.body) as { data: number }).data, 0, "the count follows the mark");

  // A notice that is already read is not marked twice, and an unknown id is not
  // distinguishable from someone else's notice by its status.
  const again = await put(`/api/authoring/notifications/${MOCK_NOTIFICATION.id}/read`, "{}", { cookie: DESK_COOKIE });
  assert.equal(again.status, 404);

  resetMockNotifications();
  const all = await post("/api/authoring/notifications/read-all", "{}", { cookie: DESK_COOKIE });
  assert.equal(all.status, 200);
  assert.equal((JSON.parse(all.body) as { data: number }).data, 1, "read-all reports what it marked");
  const afterAll = await get("/api/authoring/notifications/unread-count", { cookie: DESK_COOKIE });
  assert.equal((JSON.parse(afterAll.body) as { data: number }).data, 0);
});

test("the inbox's writes are origin-checked, and a malformed id never reaches the API", async () => {
  mockApi.resetRequests();
  const crossAll = await post("/api/authoring/notifications/read-all", "{}", {
    cookie: DESK_COOKIE,
    origin: "https://attacker.example",
  });
  assert.equal(crossAll.status, 403);
  assert.match(crossAll.body, /ORIGIN_REJECTED/);
  const crossOne = await put(`/api/authoring/notifications/${MOCK_NOTIFICATION.id}/read`, "{}", {
    cookie: DESK_COOKIE,
    origin: "https://attacker.example",
  });
  assert.equal(crossOne.status, 403);
  assert.deepEqual(mockApi.requests(), [], "a cross-origin write must not be forwarded at all");

  const malformed = await put("/api/authoring/notifications/not-a-uuid/read", "{}", { cookie: DESK_COOKIE });
  assert.equal(malformed.status, 400);
  assert.match(malformed.body, /BAD_USER_INPUT/);

  // Order: origin first, so a cross-origin caller cannot use the status code to
  // learn which notification ids exist.
  const both = await put("/api/authoring/notifications/not-a-uuid/read", "{}", {
    cookie: DESK_COOKIE,
    origin: "https://attacker.example",
  });
  assert.equal(both.status, 403);

  const anonymous = await put(`/api/authoring/notifications/${MOCK_NOTIFICATION.id}/read`, "{}");
  assert.equal(anonymous.status, 401);
});

/**
 * `PUT /api/authoring/password`.
 *
 * The route is a thin adapter over the shared `web-http` handler, so what these
 * assertions prove is the adapter: the path is wired, the method and the
 * exact-Origin check are the shared one's, the cookie's token reaches the API,
 * and the answer is passed through with the private cache policy intact. The
 * rules themselves live in the API and are tested there.
 */
test("a password change reaches the API with the cookie's token, and only as a same-origin PUT", async () => {
  const session = { cookie: `nw_access=${MOCK_TOKENS.accessToken}; nw_refresh=${MOCK_TOKENS.refreshToken}` };

  const signedOut = await put(
    "/api/authoring/password",
    JSON.stringify({ currentPassword: MOCK_CREDENTIALS.password, newPassword: "a-brand-new-password" }),
  );
  assert.equal(signedOut.status, 401, "without a session there is nothing to change");

  const changed = await put(
    "/api/authoring/password",
    JSON.stringify({ currentPassword: MOCK_CREDENTIALS.password, newPassword: "a-brand-new-password" }),
    session,
  );
  assert.equal(changed.status, 200);
  assert.match(changed.headers.get("cache-control") ?? "", /no-store/);
  assert.match(changed.body, /"revokedSessions":2/, "the answer says how many other devices were signed out");

  const foreign = await put(
    "/api/authoring/password",
    JSON.stringify({ currentPassword: MOCK_CREDENTIALS.password, newPassword: "a-brand-new-password" }),
    { ...session, origin: "https://attacker.example" },
  );
  assert.equal(foreign.status, 403);
  assert.match(foreign.body, /ORIGIN_REJECTED/);

  // A password is never readable. React Router answers a resource route that
  // exports only an action, so the refusal happens before the shared handler is
  // reached; that handler's own method contract — 405 for anything that is not
  // a PUT — is asserted in `web-http`.
  const read = await get("/api/authoring/password", session);
  assert.ok(read.status >= 400 && read.status < 500, "a GET must never reach the API");
});

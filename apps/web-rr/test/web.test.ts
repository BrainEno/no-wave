/**
 * Behavior tests for the Web application.
 *
 * They run against the **production build** served by `node server.ts`, over real
 * HTTP, with a real (mock) REST API on a second port. Nothing is stubbed inside
 * the app, so a passing run proves the deployment shape ADR 0012 requires:
 * server rendering, metadata, hard 404s, cookie-based auth and no-store private
 * responses on plain Node.js with no Vercel bindings.
 */

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { MOCK_CREDENTIALS, MOCK_DISPLAY_NAME, MOCK_TOKENS } from "../mocks/rest-api.ts";
import { registerPublicWebApp, baseUrl, get, post, withMailEnabledServer } from "./support/web-behavior-harness.ts";

registerPublicWebApp();

test("home renders API-backed articles on the server", async () => {
  const result = await get("/");
  assert.equal(result.status, 200);
  assert.match(result.body, /可移植的文学基础设施/);
  // Unique to the mock API: the fixture registry never contains this summary.
  assert.match(result.body, /从框架依赖中取回叙事自主权的实践记录。/);
  // `WorkRow` from `@bot-thk/web-ui` renders its links through the navigation seam.
  assert.match(result.body, /href="\/articles\/portable-web-foundation"/);
});

/**
 * Client-side navigation fetches `/en.data`, not `/en`.
 *
 * React Router's request pass-through (`future.v8_passThroughRequests`, the v8
 * default) hands handlers the raw `Request`, so `new URL(request.url).pathname`
 * sees the `.data` suffix and an `/en` prefix test fails: the English home would
 * hydrate in Chinese even though its server-rendered HTML was English. The
 * loaders therefore read the framework's normalized `url` instead, and this
 * asserts the answer is the same either way the page is asked for.
 */
test("the English home answers in English when it is fetched as data, not just as a document", async () => {
  const document = await get("/en");
  assert.equal(document.status, 200);
  assert.match(document.body, /lang="en"/);

  const data = await get("/en.data");
  assert.equal(data.status, 200);
  assert.match(data.body, /"en-home"/, "the data request matches the English route");
  assert.match(data.body, /"locale","en"/, "and it loads English content");

  // The root's data request moved from `/_root.data` to `/_.data` in this
  // version; the default locale must still be what the root route answers.
  const root = await get("/_.data");
  assert.equal(root.status, 200);
  assert.match(root.body, /"locale","zh-CN"/);
});

/**
 * The site shell — navigation, language switch, notification panel, footer — is
 * the one thing a status code cannot tell you about. A page with no navigation
 * still has a status, a title, a canonical URL and its content, so every one of
 * those assertions would pass on a page the visitor cannot leave. These
 * assertions are therefore about the shell itself: it is on every page, and it
 * is on the page a visitor most needs a way out of.
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

  // The page a visitor most needs a way out of, rendered inside the shell like
  // every other page.
  const missing = await get("/articles/does-not-exist");
  assert.equal(missing.status, 404);
  assert.match(missing.body, /class="nw-pill"/, "a 404 must still offer the navigation");
  assert.match(missing.body, /class="nw-footer"/);
});

test("article route server-renders content, canonical alternates and Open Graph metadata", async () => {
  const result = await get("/articles/portable-web-foundation");
  assert.equal(result.status, 200);
  // The site title suffix comes from the site's title template
  // ("%s | 无浪潮"); see app/lib/meta.ts.
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
    { origin: baseUrl.replace(/^http:/, "https:"), "x-forwarded-proto": "https" },
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

test("a throttled login relays Retry-After and drops other upstream headers", async () => {
  const result = await post("/api/auth/login", JSON.stringify({
    email: "rate-limited@example.test",
    password: MOCK_CREDENTIALS.password,
  }));
  assert.equal(result.status, 429);
  assert.equal(result.headers.get("retry-after"), "12");
  assert.equal(result.headers.get("x-upstream-only"), null);
  assert.match(result.body, /RATE_LIMITED/);
  assert.equal(result.headers.getSetCookie().length, 0, "a refused login writes no cookies");
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
  // The redirect is decided by a cookie, so it is per-visitor: a shared cache
  // that held it would send a signed-in reader to the sign-in page.
  assert.match(result.headers.get("cache-control") ?? "", /no-store/i);
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
  assert.doesNotMatch(marker, /HttpOnly/, "SiteChrome reads the marker from document.cookie after hydration");
  assert.match(marker, /SameSite=Lax/);
  assert.match(result.headers.getSetCookie().find((cookie) => cookie.startsWith("nw_access=")) ?? "", /HttpOnly/);
  assert.match(result.headers.getSetCookie().find((cookie) => cookie.startsWith("nw_refresh=")) ?? "", /HttpOnly/);
  const value = marker.slice("nw_session=".length, marker.indexOf(";"));
  assert.match(value, /^\d+$/, "the marker carries an expiry, never a credential");
});

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
  // The handler behind `/api/auth/:action` is shared
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

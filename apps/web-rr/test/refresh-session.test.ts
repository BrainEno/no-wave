import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { createApiServer } from "../../api/src/server.ts";
import { signAccessToken } from "../../api/src/security/authentication.ts";
import { createRefreshQuotaFixture } from "../../api/src/persistence/test-support/refresh-quota-fixture.ts";
import { callFrom, closeServer, listen, FIRST_CLIENT } from "./support/client-address-stack.ts";
import { startProductionWeb } from "./support/production-web.ts";

function expiredAccess(fixture: Awaited<ReturnType<typeof createRefreshQuotaFixture>>) {
  const now = Math.floor(Date.now() / 1000);
  return signAccessToken({ subject: fixture.userId, tokenId: fixture.initial.accessTokenId,
    sessionId: fixture.initial.sessionId, issuedAt: now - 600, expiresAt: now - 60, env: fixture.env });
}
function cookieValue(headers: Headers, name: string) {
  return headers.getSetCookie().find((value) => value.startsWith(`${name}=`))?.split(";")[0]?.slice(name.length + 1);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

for (const provider of ["sqlite", "postgres"] as const) {
  const options = { skip: provider === "postgres" && !process.env.TEST_DATABASE_URL, timeout: 45_000 };

  test(`${provider}: the production bundle shares one default refresh across explicit, private and viewer entry points`, options, async (t) => {
    const f = await createRefreshQuotaFixture(provider);
    t.after(() => f.cleanup());
    const article = await f.store.createArticle({ authorId: f.userId, slug: `refresh-view-${f.userId}`, title: "A guarded view",
      locale: "en", contentBlocks: [{ id: "p", type: "paragraph", text: "Never count an author's refresh as anonymous." }], publish: true });
    const entered = deferred(), release = deferred();
    let rotations = 0;
    const api = createApiServer({ env: f.env, store: { ...f.store, async rotateIdentityRefresh(input) {
      rotations++;
      entered.resolve();
      await release.promise;
      return f.store.rotateIdentityRefresh(input);
    } }, logger: () => {} });
    t.after(() => closeServer(api));
    const apiOrigin = await listen(api);
    const web = await startProductionWeb({ API_BASE_URL: apiOrigin, API_TIMEOUT_MS: "5000", BFF_CLIENT_ADDRESS_SECRET: "",
      WEB_TRUSTED_PROXY_HOPS: "0", WEB_TRUSTED_PROXY_PEERS: "" });
    t.after(() => web.close());
    const refreshOnly = `nw_refresh=${f.initial.refreshToken}`;
    const fullCookie = `nw_access=${expiredAccess(f)}; ${refreshOnly}`;
    // Auth's Path never includes nw_access. The private route does include it.
    const explicit = callFrom(web.origin, FIRST_CLIENT, "/api/auth/refresh", { headers: { cookie: refreshOnly } });
    await entered.promise;
    const automatic = callFrom(web.origin, FIRST_CLIENT, "/api/authoring/session", { method: "GET", headers: { cookie: fullCookie } });
    const withoutAccess = callFrom(web.origin, FIRST_CLIENT, "/api/authoring/session", { method: "GET", headers: { cookie: refreshOnly } });
    const viewer = callFrom(web.origin, FIRST_CLIENT, `/api/authoring/articles/${article.slug}/views?locale=en`, { headers: { cookie: fullCookie } });
    release.resolve();
    const responses = await Promise.all([explicit, automatic, withoutAccess, viewer]);
    assert.deepEqual(responses.map(({ status }) => status), [200, 200, 200, 200]);
    assert.equal(rotations, 1, "no duplicate rotation may reach the one-time API");
    const nextRefresh = cookieValue(responses[0]!.headers, "nw_refresh");
    const nextAccess = cookieValue(responses[0]!.headers, "nw_access");
    assert.ok(nextRefresh && nextAccess);
    assert.notEqual(nextRefresh, f.initial.refreshToken);
    for (const response of responses) {
      assert.equal(cookieValue(response.headers, "nw_refresh"), nextRefresh);
      assert.equal(cookieValue(response.headers, "nw_access"), nextAccess);
      assert.equal(response.headers.getSetCookie().length, 3);
      assert.match(response.headers.get("cache-control") ?? "", /no-store/);
      assert.equal(response.text.includes(nextAccess), false);
      assert.equal(response.text.includes(nextRefresh), false);
      assert.equal(response.headers.get("x-nw-client-address-proof"), null);
    }
    assert.deepEqual(JSON.parse(responses[0]!.text).data.tokenType, "Bearer");
    assert.equal(JSON.parse(responses[1]!.text).data.id, f.userId);
    assert.equal(JSON.parse(responses[2]!.text).data.id, f.userId);
    assert.deepEqual(JSON.parse(responses[3]!.text).data, { counted: false, viewCount: 0 });
    const claims = JSON.parse(Buffer.from(nextAccess.split(".")[1]!, "base64url").toString()) as { jti: string };
    assert.equal(await f.store.isSessionRevoked(claims.jti), false, "a sibling must not invalidate the winner");
    assert.equal((await f.refreshRows()).length, 2);
    assert.equal((await f.buckets()).find(({ key }) => key === f.rateKey("refresh:session", f.initial.sessionId))!.attempts, 1);
    const current = await callFrom(web.origin, FIRST_CLIENT, "/api/authoring/session", { method: "GET", headers: { cookie: `nw_access=${nextAccess}; nw_refresh=${nextRefresh}` } });
    assert.equal(current.status, 200);
    assert.equal(JSON.parse(current.text).data.id, f.userId);
    assert.equal(rotations, 1);
  });

  test(`${provider}: an automatic production refresh relays durable session 429 and leaves the jar renewable`, options, async (t) => {
    const f = await createRefreshQuotaFixture(provider);
    t.after(() => f.cleanup());
    for (let index = 0; index < 120; index++) await f.store.consumeRateLimit({ key: f.rateKey("refresh:session", f.initial.sessionId), limit: 120, windowSeconds: 900 });
    const api = createApiServer({ store: f.store, env: f.env, logger: () => {} });
    t.after(() => closeServer(api));
    const web = await startProductionWeb({ API_BASE_URL: await listen(api), API_TIMEOUT_MS: "5000", BFF_CLIENT_ADDRESS_SECRET: "" });
    t.after(() => web.close());
    const cookie = `nw_access=${expiredAccess(f)}; nw_refresh=${f.initial.refreshToken}`;
    const automatic = await callFrom(web.origin, FIRST_CLIENT, "/api/authoring/session", { method: "GET", headers: { cookie } });
    const explicit = await callFrom(web.origin, FIRST_CLIENT, "/api/auth/refresh", { headers: { cookie: `nw_refresh=${f.initial.refreshToken}` } });
    for (const response of [automatic, explicit]) {
      assert.equal(response.status, 429);
      assert.equal(JSON.parse(response.text).error.code, "RATE_LIMITED");
      assert.match(response.headers.get("retry-after") ?? "", /^[1-9][0-9]{0,3}$/);
      assert.ok(Number(response.headers.get("retry-after")) <= 900);
      assert.match(response.headers.get("cache-control") ?? "", /no-store/);
      assert.deepEqual(response.headers.getSetCookie(), []);
      assert.equal(response.text.includes(f.initial.refreshToken), false);
    }
    assert.equal((await f.refreshRows()).length, 1);
    assert.equal((await f.refreshRows())[0]!.used_at, null, "throttling cannot spend the credential");
    assert.deepEqual(await f.store.findIdentityRefreshSession({ refreshHash: f.initial.refreshHash }), { sessionId: f.initial.sessionId });
    // A new generation/session must not inherit the failed result of this key.
    const another = await f.seedSession();
    const independent = await callFrom(web.origin, FIRST_CLIENT, "/api/auth/refresh", { headers: { cookie: `nw_refresh=${another.refreshToken}` } });
    assert.equal(independent.status, 200);
    assert.ok(cookieValue(independent.headers, "nw_refresh"));
    assert.equal((await f.refreshRows(another.sessionId)).length, 2);
    assert.equal((await f.refreshRows()).length, 1);
  });

  test(`${provider}: rejected and uncertain production refreshes preserve their distinct cookie semantics`, options, async (t) => {
    const f = await createRefreshQuotaFixture(provider);
    t.after(() => f.cleanup());
    const api = createApiServer({ store: f.store, env: f.env, logger: () => {} });
    t.after(() => closeServer(api));
    const apiOrigin = await listen(api);
    const web = await startProductionWeb({ API_BASE_URL: apiOrigin, API_TIMEOUT_MS: "100", BFF_CLIENT_ADDRESS_SECRET: "" });
    t.after(() => web.close());
    const invalidCookie = `nw_refresh=${randomBytes(32).toString("base64url")}`;
    const invalid = await callFrom(web.origin, FIRST_CLIENT, "/api/authoring/session", { method: "GET", headers: { cookie: invalidCookie } });
    assert.equal(invalid.status, 401);
    const cleared = invalid.headers.getSetCookie();
    assert.equal(cleared.length, 3);
    assert.ok(cleared.every((value) => value.includes("Max-Age=0")));
    assert.ok(cleared.some((value) => value.startsWith("nw_access=;") && value.includes("Path=/api/authoring")));
    assert.ok(cleared.some((value) => value.startsWith("nw_refresh=;") && value.includes("Path=/api;")));
    assert.ok(cleared.some((value) => value.startsWith("nw_session=;") && value.includes("Path=/;")));
    const before = await f.refreshRows();
    await closeServer(api);
    const unavailable = await callFrom(web.origin, FIRST_CLIENT, "/api/auth/refresh", { headers: { cookie: `nw_refresh=${f.initial.refreshToken}` } });
    assert.equal(unavailable.status, 502);
    assert.equal(JSON.parse(unavailable.text).error.code, "SERVICE_UNAVAILABLE");
    assert.deepEqual(unavailable.headers.getSetCookie(), []);
    assert.equal(unavailable.text.includes(apiOrigin), false);
    assert.equal(unavailable.text.includes(f.initial.refreshToken), false);
    assert.deepEqual(await f.refreshRows(), before);
    assert.deepEqual(await f.store.findIdentityRefreshSession({ refreshHash: f.initial.refreshHash }), { sessionId: f.initial.sessionId });
  });
}

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import test from "node:test";
import { handleAuthRequest } from "../src/auth.ts";
import { forwardAuthoringRequest } from "../src/forward.ts";
import { handlePublicMediaRequest } from "../src/media.ts";
import { handleNotificationsReadAllRequest } from "../src/notifications.ts";
import { createWebClientAddressBridge, upstreamClientAddressHeaders } from "../src/client-address.node.ts";
import { API_BASE, ROTATED, TOKENS, json, request, setCookies, stubFetch, tokenEnvelope, type StubCall } from "./helpers.ts";

const SECRET = "fixture-proxy-client-address-secret-not-for-production";
const NOW = 1_800_000_000_000;
const CLIENT = "192.0.2.7";
const cookie = `nw_access=${TOKENS.accessToken}; nw_refresh=${TOKENS.refreshToken}`;
const incoming = (address = CLIENT) => ({ socket: { remoteAddress: address }, headers: { "x-forwarded-for": "198.51.100.88" } }) as unknown as Pick<IncomingMessage, "socket" | "headers">;
const bridge = () => createWebClientAddressBridge({ BFF_CLIENT_ADDRESS_SECRET: SECRET }, () => NOW);
const addressConfig = { apiBaseUrl: API_BASE, clientAddressHeaders: upstreamClientAddressHeaders };
function assertProof(call: StubCall, address = CLIENT) {
  const target = new URL(call.url);
  const headers = new Headers(call.init?.headers);
  const signature = createHmac("sha256", SECRET).update(JSON.stringify(["no-wave:bff-client-address:v1", NOW / 1000, call.init?.method, target.pathname + target.search, address])).digest("hex");
  assert.equal(headers.get("x-nw-client-address"), address);
  assert.equal(headers.get("x-nw-client-address-proof"), `v1.${NOW / 1000}.${signature}`);
  assert.equal(headers.has("x-forwarded-for"), false);
  assert.equal(headers.has("forwarded"), false);
  assert.equal(headers.has("x-real-ip"), false);
  assert.equal(headers.has("cookie"), false);
  assert.equal(call.init?.redirect, "error");
}
const noPrivateResponseHeaders = (response: Response) => {
  assert.equal(response.headers.get("x-nw-client-address"), null);
  assert.equal(response.headers.get("x-nw-client-address-proof"), null);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
};

test("all identity actions receive only server-owned address metadata and keep body/cookie contracts", async () => {
  const bodies: Record<string, object> = { login: { email: "reader@example.test", password: "fixture" }, register: { email: "new@example.test", password: "fixture" },
    "forgot-password": { email: "reader@example.test" }, "reset-password": { token: "link", password: "fixture" }, "verify-email": { token: "link" } };
  for (const action of ["login", "register", "refresh", "logout", "forgot-password", "reset-password", "verify-email"]) {
    const stub = stubFetch({ [`api/v1/auth/${action}`]: () => ["login", "register", "refresh"].includes(action) ? tokenEnvelope() : json({ data: { ok: true } }) });
    const client = request(`/api/auth/${action}`, { headers: { cookie, "x-forwarded-for": "203.0.113.88", "x-nw-client-address": "203.0.113.89", "x-nw-client-address-proof": "forged" },
      body: JSON.stringify(bodies[action] ?? {}) });
    const response = await bridge().run(incoming(), () => handleAuthRequest(client, action, { ...addressConfig, fetchImpl: stub.fetchImpl }));
    assert.equal(response.status, 200, action);
    assert.equal(stub.calls.length, 1);
    assertProof(stub.calls[0]!);
    const sent = JSON.parse(String(stub.calls[0]!.init?.body));
    assert.deepEqual(sent, ["refresh", "logout"].includes(action) ? { refreshToken: TOKENS.refreshToken } : bodies[action]);
    noPrivateResponseHeaders(response);
    const text = await response.text();
    assert.equal(text.includes(SECRET), false);
    assert.equal(text.includes(TOKENS.accessToken), false);
    assert.equal(text.includes(TOKENS.refreshToken), false);
  }
});

test("resource forwarding signs the actual API method/path/query without changing bytes or idempotency", async () => {
  const body = '{ "contentBlocks": [], "title": "Draft" }';
  const stub = stubFetch({ "api/v1/articles?locale=en": () => json({ data: { id: "created" } }, 201) });
  const client = request("/api/authoring/articles", { body, headers: { cookie, "idempotency-key": "fixture-create-key", "x-nw-client-address": "forged" } });
  const response = await bridge().run(incoming(), () => forwardAuthoringRequest(client, "api/v1/articles?locale=en", "POST", { ...addressConfig, fetchImpl: stub.fetchImpl }, body));
  assert.equal(response.status, 201);
  assert.equal(stub.calls.length, 1);
  assertProof(stub.calls[0]!);
  const headers = new Headers(stub.calls[0]!.init?.headers);
  assert.equal(headers.get("authorization"), `Bearer ${TOKENS.accessToken}`);
  assert.equal(headers.get("idempotency-key"), "fixture-create-key");
  assert.equal(headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(stub.calls[0]!.init?.body, body);
  assert.equal(stub.calls[0]!.init?.cache, "no-store");
  noPrivateResponseHeaders(response);
});

test("identity guards, automatic refresh, repeated guard and resource each get their own bound proof", async () => {
  let identities = 0;
  const stub = stubFetch({
    "api/v1/auth/refresh": () => tokenEnvelope(ROTATED),
    "api/v1/me": () => ++identities === 1 ? json({ error: { code: "UNAUTHENTICATED" } }, 401) : json({ data: { id: "original-reader" } }),
    "api/v1/notifications": () => json({ data: [] }),
  });
  const response = await bridge().run(incoming(), () => forwardAuthoringRequest(request("/api/authoring/notifications", { headers: { cookie } }),
    "api/v1/notifications", "GET", { ...addressConfig, fetchImpl: stub.fetchImpl }, undefined, undefined, "original-reader"));
  assert.equal(response.status, 200);
  assert.deepEqual(stub.calls.map((call) => [new URL(call.url).pathname, call.init?.method]), [
    ["/api/v1/me", "GET"], ["/api/v1/auth/refresh", "POST"], ["/api/v1/me", "GET"], ["/api/v1/notifications", "GET"],
  ]);
  for (const call of stub.calls) assertProof(call);
  assert.equal(new Headers(stub.calls[2]!.init?.headers).get("authorization"), `Bearer ${ROTATED.accessToken}`);
  assert.equal(new Headers(stub.calls[3]!.init?.headers).get("authorization"), `Bearer ${ROTATED.accessToken}`);
  assert.ok(setCookies(response).some((value) => value.startsWith(`nw_access=${ROTATED.accessToken}`)));
  noPrivateResponseHeaders(response);
});

test("a guard conflict never forwards the protected mutation even when address metadata is valid", async () => {
  const stub = stubFetch({ "api/v1/me": () => json({ data: { id: "replacement-reader" } }) });
  const response = await bridge().run(incoming(), () => handleNotificationsReadAllRequest(request("/api/authoring/notifications/read-all", {
    headers: { cookie, "x-expected-notification-actor": "original-reader" },
  }), { ...addressConfig, fetchImpl: stub.fetchImpl }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "ACCOUNT_CHANGED");
  assert.equal(stub.calls.length, 1);
  assertProof(stub.calls[0]!);
  assert.equal(new URL(stub.calls[0]!.url).pathname, "/api/v1/me");
  assert.equal(new Headers(stub.calls[0]!.init?.headers).has("x-expected-notification-actor"), false);
  assert.equal(setCookies(response).length, 0);
  noPrivateResponseHeaders(response);
});

test("no Origin or method failure spends an upstream address proof or starts an authentication call", async () => {
  let proofs = 0;
  const stub = stubFetch({});
  const config = { ...addressConfig, fetchImpl: stub.fetchImpl, clientAddressHeaders: () => { proofs++; return {}; } };
  const foreign = request("/api/auth/login", { headers: { origin: "https://outside.example.test" }, body: "{}" });
  assert.equal((await handleAuthRequest(foreign, "login", config)).status, 403);
  const wrongMethod = request("/api/authoring/notifications/read-all", { method: "GET" });
  assert.equal((await handleNotificationsReadAllRequest(wrongMethod, config)).status, 405);
  const malformed = request("/api/auth/login", { body: "not-json" });
  assert.equal((await handleAuthRequest(malformed, "login", config)).status, 400);
  assert.equal(proofs, 0);
  assert.deepEqual(stub.calls, []);
});

test("public media gets address provenance but retains conditional reads, byte policy and public caching", async () => {
  const id = "10000000-0000-4000-8000-000000000001";
  const etag = '"' + "a".repeat(64) + '"';
  const stub = stubFetch({ [`api/v1/media/${id}`]: () => new Response(null, { status: 304, headers: { etag } }) });
  const response = await bridge().run(incoming(), () => handlePublicMediaRequest(request(`/api/media/${id}`, { method: "GET", headers: {
    "if-none-match": etag, cookie, "x-forwarded-for": "203.0.113.1",
  } }), id, { ...addressConfig, fetchImpl: stub.fetchImpl }));
  assert.equal(response.status, 304);
  assert.equal(stub.calls.length, 1);
  assertProof(stub.calls[0]!);
  assert.equal(new Headers(stub.calls[0]!.init?.headers).get("if-none-match"), etag);
  assert.equal(new Headers(stub.calls[0]!.init?.headers).has("authorization"), false);
  assert.equal(response.headers.get("etag"), etag);
  assert.match(response.headers.get("cache-control") ?? "", /public.*immutable/);
  assert.equal(response.headers.get("x-nw-client-address-proof"), null);
  assert.equal(await response.text(), "");
});

test("a metadata provider cannot replace bearer, cookies, content type or an idempotency key", async () => {
  const stub = stubFetch({ "api/v1/articles": () => json({ data: { id: "created" } }) });
  const response = await forwardAuthoringRequest(request("/api/authoring/articles", { headers: { cookie, "idempotency-key": "original-key" } }),
    "api/v1/articles", "POST", { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl, clientAddressHeaders: () => ({
      "x-nw-client-address": CLIENT, "x-nw-client-address-proof": "fixture-proof", authorization: "Bearer forged",
      cookie: "secret=forged", "content-type": "text/plain", "idempotency-key": "replacement-key", "x-forwarded-for": "203.0.113.7",
    }) }, "{}");
  assert.equal(response.status, 200);
  const headers = new Headers(stub.calls[0]!.init?.headers);
  assert.equal(headers.get("authorization"), `Bearer ${TOKENS.accessToken}`);
  assert.equal(headers.get("idempotency-key"), "original-key");
  assert.equal(headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(headers.get("cookie"), null);
  assert.equal(headers.get("x-forwarded-for"), null);
  assert.equal(headers.get("x-nw-client-address"), CLIENT);
  assert.equal(headers.get("x-nw-client-address-proof"), "fixture-proof");
});

test("an injected transport without a server-owned provider never forwards forged browser metadata", async () => {
  const stub = stubFetch({ "api/v1/me": () => json({ data: { id: "reader" } }) });
  const result = await forwardAuthoringRequest(request("/api/authoring/session", { method: "GET", headers: {
    cookie, "x-nw-client-address": CLIENT, "x-nw-client-address-proof": "forged", "x-forwarded-for": CLIENT,
  } }), "api/v1/me", "GET", { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });
  assert.equal(result.status, 200);
  const headers = new Headers(stub.calls[0]!.init?.headers);
  assert.equal(headers.has("x-nw-client-address"), false);
  assert.equal(headers.has("x-nw-client-address-proof"), false);
  assert.equal(headers.has("x-forwarded-for"), false);
  assert.equal(headers.get("authorization"), `Bearer ${TOKENS.accessToken}`);
  noPrivateResponseHeaders(result);
});

test("a signing failure is a sanitized upstream failure, never a partially forwarded mutation", async () => {
  const stub = stubFetch({});
  const provider = () => { throw new Error(`fixture private failure ${SECRET}`); };
  const config = { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl, clientAddressHeaders: provider };
  const response = await forwardAuthoringRequest(request("/api/authoring/articles"), "api/v1/articles", "POST", config, "{}");
  assert.equal(response.status, 502);
  assert.equal((await response.text()).includes(SECRET), false);
  const auth = await handleAuthRequest(request("/api/auth/login", { body: "{}" }), "login", config);
  assert.equal(auth.status, 502);
  assert.equal(setCookies(auth).length, 0);
  const logout = await handleAuthRequest(request("/api/auth/logout", { headers: { cookie } }), "logout", config);
  assert.equal(logout.status, 502);
  assert.ok(setCookies(logout).every((value) => value.includes("Max-Age=0")));
  assert.deepEqual(stub.calls, []);
});

test("a live upstream redirect cannot carry signed metadata or an auth payload to a different origin", async (t) => {
  const received: string[] = [];
  const destination = createServer((request, response) => { received.push(request.url ?? ""); response.writeHead(200); response.end("unexpected"); });
  const source = createServer((_request, response) => { response.writeHead(307, { location: destinationOrigin + "/stolen" }); response.end(); });
  t.after(async () => { for (const server of [source, destination]) { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); } });
  await new Promise<void>((resolve) => destination.listen(0, "0.0.0.0", resolve));
  const address = destination.address();
  assert.ok(address && typeof address === "object");
  const destinationOrigin = `http://127.0.0.1:${address.port}`;
  await new Promise<void>((resolve) => source.listen(0, "0.0.0.0", resolve));
  const from = source.address();
  assert.ok(from && typeof from === "object");
  const config = { ...addressConfig, apiBaseUrl: `http://127.0.0.1:${from.port}` };
  const response = await bridge().run(incoming(), () => handleAuthRequest(request("/api/auth/login", { body: '{"password":"fixture"}' }), "login", config));
  assert.equal(response.status, 502);
  assert.deepEqual(received, []);
  assert.equal(response.headers.get("location"), null);
  assert.equal((await response.text()).includes(SECRET), false);
  const resource = await bridge().run(incoming(), () => forwardAuthoringRequest(request("/api/authoring/session", { headers: { cookie } }), "api/v1/me", "GET", config));
  assert.equal(resource.status, 502);
  assert.deepEqual(received, []);
});

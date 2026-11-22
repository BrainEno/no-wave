import assert from "node:assert/strict";
import test from "node:test";

import { AUTHORING_NOTION_OAUTH_MAX_BYTES, handleAuthoringNotionOAuthRequest } from "../src/authoring.ts";
import { API_BASE, assertNoStore, json, request, stubFetch } from "./helpers.ts";

/**
 * `/api/authoring/notion-oauth[/start|/exchange]` (ADR 0053): the proxy in front of
 * the one-shot Notion OAuth. It decides only whether a request is one of the three
 * calls; the state is verified by the API against the session. These cases pin
 * what the desk relies on: same-origin POSTs, `no-store` answers, and no refusal
 * the proxy writes itself repeating the code.
 */

const CODE = "TESTONLY-CODE-0001";
const ACCESS = "ntn_TESTONLY_oauth_access_0123456789";

function oauthRequest(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Request {
  return request(`/api/authoring/notion-oauth${path}`, { ...init, headers: { host: "no-wave.test", ...init.headers } });
}

test("status, start and exchange reach their own API routes, and every answer is no-store", async () => {
  const stub = stubFetch({
    "api/v1/imports/notion/oauth/start": () => json({ data: { authorizeUrl: "https://api.notion.com/v1/oauth/authorize?state=s", state: "s", expiresInSeconds: 600 } }),
    "api/v1/imports/notion/oauth/exchange": () => json({ data: { accessToken: ACCESS, workspaceName: "W" } }),
    "api/v1/imports/notion/oauth": () => json({ data: { enabled: true } }),
  });
  const config = { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl };

  const status = await handleAuthoringNotionOAuthRequest(oauthRequest("", { method: "GET" }), "status", config);
  assert.equal(status.status, 200);
  assertNoStore(status);
  assert.deepEqual(await status.json(), { data: { enabled: true } });

  const started = await handleAuthoringNotionOAuthRequest(oauthRequest("/start"), "start", config);
  assert.equal(started.status, 200);
  assertNoStore(started);

  const body = JSON.stringify({ code: CODE, state: "s" });
  const exchanged = await handleAuthoringNotionOAuthRequest(oauthRequest("/exchange", { body }), "exchange", config);
  assert.equal(exchanged.status, 200);
  assertNoStore(exchanged);
  assert.deepEqual(await exchanged.json(), { data: { accessToken: ACCESS, workspaceName: "W" } });

  assert.deepEqual(stub.calls.map((call) => [call.url, call.init?.method]), [
    [`${API_BASE}/api/v1/imports/notion/oauth`, "GET"],
    [`${API_BASE}/api/v1/imports/notion/oauth/start`, "POST"],
    [`${API_BASE}/api/v1/imports/notion/oauth/exchange`, "POST"],
  ]);
  assert.equal(stub.calls[2]?.init?.body, body, "the exchange body is forwarded as received");
});

test("only same-origin POSTs start or finish an authorization, and no refusal repeats the code", async () => {
  const stub = stubFetch({ "api/v1/": () => json({ data: {} }) });
  const config = { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl };
  const body = JSON.stringify({ code: CODE, state: "s" });
  const texts: string[] = [];
  const expect = async (response: Response, status: number) => {
    assert.equal(response.status, status);
    texts.push(await response.text());
  };

  await expect(await handleAuthoringNotionOAuthRequest(oauthRequest("", { body: "{}" }), "status", config), 405);
  await expect(await handleAuthoringNotionOAuthRequest(oauthRequest("/start", { method: "GET" }), "start", config), 405);
  await expect(await handleAuthoringNotionOAuthRequest(oauthRequest("/exchange", { method: "GET" }), "exchange", config), 405);
  await expect(await handleAuthoringNotionOAuthRequest(oauthRequest("/start", { headers: { origin: "https://evil.test" } }), "start", config), 403);
  await expect(await handleAuthoringNotionOAuthRequest(oauthRequest("/exchange", { body, headers: { origin: "https://evil.test" } }), "exchange", config), 403);
  await expect(await handleAuthoringNotionOAuthRequest(
    oauthRequest("/exchange", { body, headers: { "content-length": String(AUTHORING_NOTION_OAUTH_MAX_BYTES + 1) } }), "exchange", config), 413);
  for (const payload of [{ code: CODE }, { state: "s" }, { code: 1, state: "s" }]) {
    const refused = await handleAuthoringNotionOAuthRequest(oauthRequest("/exchange", { body: JSON.stringify(payload) }), "exchange", config);
    assert.equal(refused.status, 400);
    assert.equal(refused.headers.get("x-authoring-not-forwarded"), "1");
    texts.push(await refused.text());
  }
  assert.equal(stub.calls.length, 0, "no refused request reaches the API");
  for (const text of texts) assert.ok(!text.includes(CODE));
});

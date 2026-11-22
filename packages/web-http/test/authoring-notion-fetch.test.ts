import assert from "node:assert/strict";
import test from "node:test";

import { AUTHORING_NOTION_FETCH_MAX_BYTES, handleAuthoringNotionFetchRequest } from "../src/authoring.ts";
import { API_BASE, assertNoStore, json, request, stubFetch } from "./helpers.ts";

/**
 * `POST /api/authoring/notion-fetch` (ADR 0052): the proxy in front of the pull
 * that carries an author's pasted Notion token.
 *
 * The proxy forwards the body it received and decides only whether the request is
 * a pull at all. These cases pin the two properties that matter to the author: the
 * token reaches our API exactly as typed and nowhere else, and no answer the proxy
 * writes itself — a refusal, a timeout, an upstream failure — repeats it.
 */

const TOKEN = "ntn_TESTONLY_paste_me_0123456789abcdef";
const PAGE = "00000001-0000-4000-8000-000000000000";

function fetchRequest(body: string, headers: Record<string, string> = {}, method = "POST"): Request {
  const origin = { host: "no-wave.test", origin: "https://no-wave.test", ...headers };
  return method === "GET"
    ? request("/api/authoring/notion-fetch", { method, headers: origin })
    : request("/api/authoring/notion-fetch", { method, body, headers: origin });
}

test("a slice is forwarded byte for byte to the API's pull, with a 90 s budget", async () => {
  const slice = { pages: [{ id: PAGE, blocks: [] }], issues: [], done: [PAGE] };
  const stub = stubFetch({ "api/v1/imports/notion/fetch": () => json({ data: slice }) });
  const body = JSON.stringify({ token: TOKEN, mode: "pages", pageIds: [PAGE] });
  const response = await handleAuthoringNotionFetchRequest(fetchRequest(body), { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl });

  assert.equal(response.status, 200);
  assertNoStore(response);
  assert.equal(stub.calls.length, 1);
  assert.equal(stub.calls[0]?.url, `${API_BASE}/api/v1/imports/notion/fetch`);
  assert.equal(stub.calls[0]?.init?.method, "POST");
  assert.equal(stub.calls[0]?.init?.body, body);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { data: slice });
  assert.doesNotMatch(text, new RegExp(TOKEN));
});

test("Notion's rate limit reaches the desk with its Retry-After, so the desk can wait", async () => {
  const refusal = { error: { code: "NOTION_RATE_LIMITED", message: "Notion asked us to slow down." } };
  const stub = stubFetch({ "api/v1/imports/notion/fetch": () => json(refusal, 429, { "retry-after": "42" }) });
  const response = await handleAuthoringNotionFetchRequest(
    fetchRequest(JSON.stringify({ token: TOKEN, mode: "rows", source: "https://www.notion.so/x" })),
    { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl },
  );
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "42");
  assert.deepEqual(await response.json(), refusal);

  // A refusal about the token is the API's sentence, passed through so the desk can
  // say which step to fix; the proxy does not rewrite it into a status code.
  const invalid = { error: { code: "NOTION_TOKEN_INVALID", message: "Notion did not accept this token." } };
  const rejected = await handleAuthoringNotionFetchRequest(
    fetchRequest(JSON.stringify({ token: TOKEN, mode: "rows", source: "x" })),
    { apiBaseUrl: API_BASE, fetchImpl: stubFetch({ "api/v1/imports/notion/fetch": () => json(invalid, 422) }).fetchImpl },
  );
  assert.equal(rejected.status, 422);
  assert.deepEqual(await rejected.json(), invalid);
});

test("a pull is bounded, same-origin, POST, and one of the two modes — and no refusal repeats the token", async () => {
  const stub = stubFetch({ "api/v1/": () => json({ data: {} }) });
  const config = { apiBaseUrl: API_BASE, fetchImpl: stub.fetchImpl };
  const body = JSON.stringify({ token: TOKEN, mode: "rows", source: "x" });
  const texts: string[] = [];
  const expect = async (response: Response, status: number) => {
    assert.equal(response.status, status);
    texts.push(await response.text());
  };

  await expect(await handleAuthoringNotionFetchRequest(fetchRequest(body, {}, "GET"), config), 405);
  await expect(await handleAuthoringNotionFetchRequest(fetchRequest(body, { origin: "https://evil.test" }), config), 403);
  await expect(await handleAuthoringNotionFetchRequest(fetchRequest(body, { "content-type": "text/plain" }), config), 415);
  await expect(await handleAuthoringNotionFetchRequest(
    fetchRequest(body, { "content-length": String(AUTHORING_NOTION_FETCH_MAX_BYTES + 1) }), config), 413);
  await expect(await handleAuthoringNotionFetchRequest(fetchRequest(`{"token":"${TOKEN}"`), config), 400);

  for (const payload of [
    { token: TOKEN },
    { token: TOKEN, mode: "search", query: "x" },
    { token: TOKEN, mode: ["rows"] },
    { mode: "rows", source: "x" },
    { token: "", mode: "rows", source: "x" },
    { token: 42, mode: "rows", source: "x" },
  ]) {
    const refused = await handleAuthoringNotionFetchRequest(fetchRequest(JSON.stringify(payload)), config);
    assert.equal(refused.status, 400, JSON.stringify(payload).slice(0, 60));
    assert.equal(refused.headers.get("x-authoring-not-forwarded"), "1");
    texts.push(await refused.text());
  }
  assert.equal(stub.calls.length, 0, "no refused pull reaches the network");
  for (const text of texts) assert.doesNotMatch(text, new RegExp(TOKEN));
});

test("an API failure or a missing API never echoes the request", async () => {
  const body = JSON.stringify({ token: TOKEN, mode: "rows", source: "x" });
  const failing = stubFetch({ "api/v1/imports/notion/fetch": () => json({ error: { code: "BOOM", message: TOKEN } }, 500) });
  const failed = await handleAuthoringNotionFetchRequest(fetchRequest(body), { apiBaseUrl: API_BASE, fetchImpl: failing.fetchImpl });
  assert.equal(failed.status >= 500, true);
  assert.doesNotMatch(await failed.text(), new RegExp(TOKEN));

  const unconfigured = await handleAuthoringNotionFetchRequest(fetchRequest(body), {});
  assert.equal(unconfigured.status, 503);
  assert.doesNotMatch(await unconfigured.text(), new RegExp(TOKEN));
});

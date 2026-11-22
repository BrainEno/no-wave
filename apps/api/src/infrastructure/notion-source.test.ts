import assert from "node:assert/strict";
import test from "node:test";

import {
  NOTION_API_ORIGIN,
  NotionApiError,
  TooManyBlocksError,
  boundedNotionFetch,
  collectBlocks,
  notionCaller,
  type NotionFetch,
} from "./notion-source.ts";

const TOKEN = "ntn_TESTONLY_secret_value_1234567890";

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return { status, ok: status >= 200 && status < 300, json: async () => body, headers: new Headers(headers) };
}

const caller = (fetchImpl: NotionFetch, onRateLimit: (s: number | null) => number | null = () => null) =>
  notionCaller({ token: TOKEN, fetchImpl, sleep: async () => {}, onRateLimit, includeNotionMessage: false });

test("a page longer than the ceiling is an error, never a truncated body", async () => {
  const fetchImpl: NotionFetch = async () => json({ results: Array.from({ length: 3 }, (_, i) => ({ id: `b${i}`, type: "paragraph", paragraph: {} })), next_cursor: null });
  await assert.rejects(() => collectBlocks("page", caller(fetchImpl), { pageSize: 100, maxBlocks: 2 }), TooManyBlocksError);
  const blocks = await collectBlocks("page", caller(fetchImpl), { pageSize: 100, maxBlocks: 3 });
  assert.equal(blocks.length, 3);
});

test("the API's caller keeps Notion's error text and the token out of the error", async () => {
  const fetchImpl: NotionFetch = async () => json({ message: "Could not find page with secret content Ω" }, 404);
  await assert.rejects(() => caller(fetchImpl)("/v1/blocks/x/children?page_size=100"), (error: unknown) => {
    assert.ok(error instanceof NotionApiError);
    assert.equal(error.status, 404);
    assert.doesNotMatch(error.message, /secret content|Ω/);
    assert.doesNotMatch(error.message, new RegExp(TOKEN));
    assert.doesNotMatch(error.message, /page_size/, "the query string is not part of the message");
    return true;
  });
});

test("a rate limit is waited out when the policy allows it, and reported with Retry-After when not", async () => {
  let calls = 0;
  const limited: NotionFetch = async () => { calls += 1; return calls === 1 ? json({}, 429, { "retry-after": "2" }) : json({ ok: true }); };
  const waits: (number | null)[] = [];
  assert.deepEqual(await caller(limited, (seconds) => { waits.push(seconds); return seconds! * 1000; })("/v1/databases/x"), { ok: true });
  assert.deepEqual(waits, [2]);

  const always: NotionFetch = async () => json({}, 429, { "retry-after": "40" });
  await assert.rejects(() => caller(always)("/v1/databases/x"), (error: unknown) => error instanceof NotionApiError && error.status === 429 && error.retryAfterSeconds === 40);
});

test("the token travels only in the Authorization header, with the pinned API version", async () => {
  const seen: { url: string; headers: Record<string, string>; body?: string }[] = [];
  const fetchImpl: NotionFetch = async (url, init) => { seen.push({ url, headers: init.headers, body: init.body }); return json({}); };
  await caller(fetchImpl)("/v1/data_sources/ds/query", { page_size: 100 });
  assert.equal(seen[0]!.url, `${NOTION_API_ORIGIN}/v1/data_sources/ds/query`);
  assert.equal(seen[0]!.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(seen[0]!.headers["notion-version"], "2025-09-03");
  assert.doesNotMatch(seen[0]!.url + (seen[0]!.body ?? ""), new RegExp(TOKEN));
});

test("calls are spaced to stay under Notion's request rate", async () => {
  let clock = 0;
  const slept: number[] = [];
  const call = notionCaller({ token: TOKEN, fetchImpl: async () => json({}), sleep: async (ms) => { slept.push(ms); clock += ms; }, now: () => clock, onRateLimit: () => null, includeNotionMessage: false, minIntervalMs: 340 });
  await call("/v1/databases/a");
  clock += 100;
  await call("/v1/databases/b");
  assert.deepEqual(slept, [240]);
});

test("the bounded transport stays on api.notion.com, follows no redirect, and caps bytes on the stream", async () => {
  const transport = (respond: () => Response) => boundedNotionFetch((async () => respond()) as typeof fetch, { maxBytes: 16 });
  const init = { method: "GET", headers: {} };

  await assert.rejects(() => transport(() => new Response("{}"))("https://example.com/v1/x", init), /outside the Notion API/);
  await assert.rejects(() => transport(() => new Response(null, { status: 302, headers: { location: "https://evil.test" } }))(`${NOTION_API_ORIGIN}/v1/x`, init), /redirect/);
  const stream = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{\"a\":\"0123456789\"")); controller.enqueue(new TextEncoder().encode("0123456789}")); controller.close(); } }));
  await assert.rejects(() => transport(stream)(`${NOTION_API_ORIGIN}/v1/x`, init), (error: unknown) => error instanceof NotionApiError && error.status === 413);

  const ok = await transport(() => new Response("{\"a\":1}", { headers: { "retry-after": "3" } }))(`${NOTION_API_ORIGIN}/v1/x`, init);
  assert.deepEqual(await ok.json(), { a: 1 });
  assert.equal(ok.headers?.get("retry-after"), "3");
});

test("an unreachable or slow Notion is reported without the URL", async () => {
  const unreachable = boundedNotionFetch((async () => { throw new TypeError(`fetch failed for ${NOTION_API_ORIGIN}/v1/secret-path`); }) as typeof fetch);
  await assert.rejects(() => unreachable(`${NOTION_API_ORIGIN}/v1/secret-path`, { method: "GET", headers: {} }), (error: unknown) => {
    assert.ok(error instanceof NotionApiError);
    assert.doesNotMatch(error.message, /secret-path/);
    return true;
  });
  const slow = boundedNotionFetch(((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  })) as typeof fetch, { timeoutMs: 20 });
  await assert.rejects(() => slow(`${NOTION_API_ORIGIN}/v1/x`, { method: "GET", headers: {} }), NotionApiError);
});

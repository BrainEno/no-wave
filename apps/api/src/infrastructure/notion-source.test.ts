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
import { notionBlocksToArticleBlocks } from "../application/notion-interchange.ts";

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

const rich = (content: string) => ({ rich_text: [{ type: "text", plain_text: content, text: { content } }] });
const para = (id: string, content: string) => ({ id, type: "paragraph", has_children: false, paragraph: rich(content) });

test("a sub-page or inline database is kept as a block but never walked into; inline containers still are", async () => {
  // The shape of the bug: a work whose last block is a child page with its own
  // body. Reading that body appended a different document after the ending.
  const tree: Record<string, unknown[]> = {
    work: [
      para("p1", "正文第一段"),
      { id: "tg", type: "toggle", has_children: true, toggle: rich("展开") },
      { id: "cl", type: "column_list", has_children: true, column_list: {} },
      { id: "sb", type: "synced_block", has_children: true, synced_block: { synced_from: { type: "block_id", block_id: "original" } } },
      para("p2", "正文最后一段"),
      { id: "cp", type: "child_page", has_children: true, child_page: { title: "Face in the wall" } },
      { id: "cd", type: "child_database", has_children: true, child_database: { title: "书单" } },
    ],
    tg: [para("tg1", "折叠里的段落")],
    cl: [{ id: "col", type: "column", has_children: true, column: {} }],
    col: [para("col1", "分栏里的段落")],
    sb: [para("sb1", "同步块里的段落")],
    cp: [para("cp1", "The face in the wall looked back.")],
    cd: [para("cd1", "数据库里的行")],
  };
  const fetched: string[] = [];
  const fetchImpl: NotionFetch = async (url) => {
    const parent = /\/v1\/blocks\/([^/]+)\/children/.exec(url)![1]!;
    fetched.push(parent);
    return json({ results: tree[parent] ?? [], next_cursor: null });
  };

  const blocks = await collectBlocks("work", caller(fetchImpl), { pageSize: 100, maxBlocks: 100 });
  assert.deepEqual(fetched, ["work", "tg", "cl", "col", "sb"], "the sub-page and the database are never requested");
  assert.deepEqual(blocks.map((block) => block.id), ["p1", "tg", "tg1", "cl", "col", "col1", "sb", "sb1", "p2", "cp", "cd"]);
  assert.deepEqual(blocks.at(-2), { id: "cp", type: "child_page", has_children: true, child_page: { title: "Face in the wall" } });

  // End to end through the mapping: the work ends where the author ended it,
  // and the report says which page stayed behind.
  const mapped = notionBlocksToArticleBlocks(blocks);
  const texts = mapped.blocks.map((block) => block.text);
  assert.deepEqual(texts, ["正文第一段", "展开", "折叠里的段落", "分栏里的段落", "同步块里的段落", "正文最后一段"]);
  assert.ok(!texts.some((text) => typeof text === "string" && /face in the wall/i.test(text)));
  assert.deepEqual(
    mapped.issues.filter((issue) => issue.code === "unsupported-block"),
    [{ code: "unsupported-block", detail: "child_page: Face in the wall" }, { code: "unsupported-block", detail: "child_database: 书单" }],
    "a synced block is carried, so it is not reported as dropped",
  );
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

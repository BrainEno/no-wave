import assert from "node:assert/strict";
import test from "node:test";

import { NOTION_API_ORIGIN, NotionApiError, collectNotionBundle, type NotionFetch } from "./notion-client.ts";

const text = (content: string) => ({ type: "text", plain_text: content, text: { content, link: null } });

function jsonResponse(body: unknown, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

/** A fetch that answers from a table of path -> bodies and records the calls. */
function stubFetch(table: Record<string, unknown[]>): { fetchImpl: NotionFetch; calls: { method: string; url: string; body?: string }[] } {
  const calls: { method: string; url: string; body?: string }[] = [];
  const fetchImpl: NotionFetch = async (url, init) => {
    calls.push({ method: init.method, url, body: init.body });
    const path = url.replace(NOTION_API_ORIGIN, "");
    const queue = table[path];
    if (queue === undefined || queue.length === 0) return jsonResponse({ message: "Not found", object: "error", code: "object_not_found" }, 404);
    return jsonResponse(queue.length > 1 ? queue.shift() : queue[0]);
  };
  return { fetchImpl, calls };
}

test("a database resolves its data source, and both the query and the body paginate", async () => {
  const { fetchImpl, calls } = stubFetch({
    "/v1/databases/db-1": [{ object: "database", id: "db-1", data_sources: [{ id: "ds-1", name: "Bottom Think" }] }],
    "/v1/data_sources/ds-1/query": [
      { object: "list", results: [{ id: "page-1", properties: { Page: { type: "title", title: [text("墙壁")] } } }], next_cursor: "cursor-1" },
      { object: "list", results: [{ id: "page-2", properties: {} }], next_cursor: null },
    ],
    "/v1/blocks/page-1/children?page_size=100": [
      {
        object: "list",
        results: [
          { id: "b1", type: "paragraph", has_children: false, paragraph: { rich_text: [text("一")] } },
          { id: "b2", type: "callout", has_children: true, callout: { rich_text: [text("提示")] } },
        ],
        next_cursor: "blocks-2",
      },
      { object: "list", results: [{ id: "b3", type: "paragraph", has_children: false, paragraph: { rich_text: [text("三")] } }], next_cursor: null },
    ],
    "/v1/blocks/page-1/children?page_size=100&start_cursor=blocks-2": [
      { object: "list", results: [{ id: "b3", type: "paragraph", has_children: false, paragraph: { rich_text: [text("三")] } }], next_cursor: null },
    ],
    "/v1/blocks/b2/children?page_size=100": [
      { object: "list", results: [{ id: "b2-1", type: "paragraph", has_children: false, paragraph: { rich_text: [text("子")] } }], next_cursor: null },
    ],
    "/v1/blocks/page-2/children?page_size=100": [{ object: "list", results: [], next_cursor: null }],
  });

  const bundle = await collectNotionBundle({ token: "secret-token", sourceId: "db-1", fetchImpl, sleep: async () => {} });

  assert.equal(bundle.version, 1);
  assert.deepEqual(bundle.database, { id: "ds-1", title: "Bottom Think" });
  assert.deepEqual(bundle.pages.map((page) => page.id), ["page-1", "page-2"], "the query's second page is not dropped");
  assert.deepEqual(bundle.pages[0]!.blocks.map((block) => block.id), ["b1", "b2", "b2-1", "b3"], "children follow their container, in order");
  assert.equal(bundle.pages[0]!.properties.Page?.type, "title");

  // The token travels in the header and the API version is pinned.
  assert.ok(calls.every((call) => call.url.startsWith(NOTION_API_ORIGIN)));
});

test("a data source id works where a database id was offered", async () => {
  const { fetchImpl } = stubFetch({
    "/v1/data_sources/ds-9/query": [{ object: "list", results: [], next_cursor: null }],
  });
  const bundle = await collectNotionBundle({ token: "t", sourceId: "ds-9", fetchImpl, sleep: async () => {} });
  assert.deepEqual(bundle.pages, []);
  assert.equal(bundle.database.id, "ds-9");
});

test("a rate limit is retried once, then reported", async () => {
  let attempts = 0;
  const fetchImpl: NotionFetch = async (url) => {
    if (url.endsWith("/v1/databases/db-2")) return jsonResponse({ data_sources: [{ id: "ds-2" }] });
    attempts += 1;
    if (attempts === 1) return jsonResponse({ message: "Too many requests" }, 429);
    return jsonResponse({ object: "list", results: [], next_cursor: null });
  };
  const bundle = await collectNotionBundle({ token: "t", sourceId: "db-2", fetchImpl, sleep: async () => {} });
  assert.equal(attempts, 2);
  assert.deepEqual(bundle.pages, []);

  const always429: NotionFetch = async (url) => (url.endsWith("/v1/databases/db-3")
    ? jsonResponse({ data_sources: [{ id: "ds-3" }] })
    : jsonResponse({ message: "Too many requests" }, 429));
  await assert.rejects(
    () => collectNotionBundle({ token: "t", sourceId: "db-3", fetchImpl: always429, sleep: async () => {} }),
    (error: unknown) => error instanceof NotionApiError && error.status === 429,
  );
});

test("an error carries the endpoint and the status, never the request", async () => {
  const fetchImpl: NotionFetch = async (url) => (url.endsWith("/v1/databases/db-4")
    ? jsonResponse({ data_sources: [{ id: "ds-4" }] })
    : jsonResponse({ message: "Unauthorized" }, 401));
  await assert.rejects(
    () => collectNotionBundle({ token: "super-secret-token", sourceId: "db-4", fetchImpl, sleep: async () => {} }),
    (error: unknown) => {
      assert.ok(error instanceof NotionApiError);
      assert.equal(error.status, 401);
      assert.match(error.message, /POST \/v1\/data_sources\/ds-4\/query/);
      assert.doesNotMatch(error.message, /super-secret-token/, "a token must never appear in an error");
      return true;
    },
  );
});

test("the page and block ceilings stop a runaway bundle", async () => {
  const pages = Array.from({ length: 5 }, (_, index) => ({ id: `p${index}`, properties: {} }));
  const fetchImpl: NotionFetch = async (url) => (url.endsWith("/v1/databases/db-5")
    ? jsonResponse({ data_sources: [{ id: "ds-5" }] })
    : url.includes("/v1/data_sources/ds-5/query")
      ? jsonResponse({ object: "list", results: pages, next_cursor: "again" })
      : jsonResponse({ object: "list", results: [], next_cursor: null }));
  const bundle = await collectNotionBundle({ token: "t", sourceId: "db-5", fetchImpl, sleep: async () => {}, maxPages: 3 });
  assert.equal(bundle.pages.length, 3);
});

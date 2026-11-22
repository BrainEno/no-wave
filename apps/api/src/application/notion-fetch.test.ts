import assert from "node:assert/strict";
import test from "node:test";

import {
  NotionFetchError,
  NotionFetchRequestError,
  fetchNotionPages,
  fetchNotionRows,
  isNotionToken,
  parseNotionId,
  readNotionFetchRequest,
} from "./notion-fetch.ts";
import { NOTION_API_ORIGIN, type NotionFetch } from "../infrastructure/notion-source.ts";

const TOKEN = "ntn_TESTONLY_secret_value_1234567890";
const DB = "0123456789abcdef0123456789abcdef";
const DB_DASHED = "01234567-89ab-cdef-0123-456789abcdef";
const id = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return { status, ok: status >= 200 && status < 300, json: async () => body, headers: new Headers(headers) };
}
const paragraph = (text: string, n: number) => ({ id: `b${n}`, type: "paragraph", has_children: false, paragraph: { rich_text: [{ plain_text: text }] }, created_by: { id: "u" } });

/** Answers by path; records every path asked for. */
function notion(routes: (path: string, body: string | undefined) => ReturnType<typeof json>): { fetchImpl: NotionFetch; paths: string[] } {
  const paths: string[] = [];
  return { paths, fetchImpl: async (url, init) => { const path = url.replace(NOTION_API_ORIGIN, ""); paths.push(path); return routes(path, init.body); } };
}
const fast = { sleep: async () => {}, limits: { minIntervalMs: 0 } };

test("an id is read from a bare id or a Notion link, never from the view query", () => {
  assert.equal(parseNotionId(DB), DB_DASHED);
  assert.equal(parseNotionId(DB_DASHED), DB_DASHED);
  assert.equal(parseNotionId(`https://www.notion.so/me/Bottom-Think-${DB}?v=ffffffffffffffffffffffffffffffff&pvs=4`), DB_DASHED);
  assert.equal(parseNotionId(`https://acme.notion.site/${DB}`), DB_DASHED);
  assert.equal(parseNotionId(`https://evil.example/${DB}`), null, "only Notion's own hosts");
  assert.equal(parseNotionId("not-an-id"), null);
  assert.equal(parseNotionId(`${DB}0`), null);
});

test("a token is checked for shape, and no validation message repeats it", () => {
  assert.equal(isNotionToken(TOKEN), true);
  assert.equal(isNotionToken("secret_abcdefghijklmnopqrstuvwxyz"), true);
  // The prefix is not checked: Notion treats tokens as opaque, and an OAuth access
  // token's shape is not documented.
  assert.equal(isNotionToken("nat_0123456789ABCDEFabcdef-._~+/=="), true);
  for (const bad of [
    "Bearer ntn_abcdefghijklmnopqrstuvwxyz", "ntn_short", `ntn_${"a".repeat(500)}`, "ntn_with space 0123456789",
    "ntn_line\r\nX-Injected: 0123456789", "https://www.notion.so/workspace/0123456789abcdef", "ntn_令牌_0123456789abcdefghij", "==ntn_0123456789abcdefghij", 42,
  ]) assert.equal(isNotionToken(bad), false, String(bad));

  const attempts = [
    { token: "sk-live 0123456789abcdef0123", mode: "rows", source: DB },
    { token: TOKEN, mode: "rows", source: "https://evil.example/x" },
    { token: TOKEN, mode: "rows", source: DB, cursor: "bad cursor!" },
    { token: TOKEN, mode: "pages", pageIds: [] },
    { token: TOKEN, mode: "pages", pageIds: Array.from({ length: 201 }, (_, n) => id(n)) },
    { token: TOKEN, mode: "pages", pageIds: ["../../v1/users"] },
    { token: TOKEN, mode: "search" },
  ];
  for (const body of attempts) {
    assert.throws(() => readNotionFetchRequest(body), (error: unknown) => {
      assert.ok(error instanceof NotionFetchRequestError);
      assert.doesNotMatch(error.message, /sk-live|ntn_TESTONLY/);
      return true;
    });
  }
  assert.deepEqual(readNotionFetchRequest({ token: TOKEN, mode: "pages", pageIds: [id(1), id(1).replaceAll("-", ""), id(2)] }), { mode: "pages", token: TOKEN, pageIds: [id(1), id(2)] });
});

test("rows are listed through the database's data source, across Notion's pages", async () => {
  const { fetchImpl, paths } = notion((path, body) => {
    if (path === `/v1/databases/${DB_DASHED}`) return json({ data_sources: [{ id: "ds-1", name: "作品库" }] });
    const cursor = body ? (JSON.parse(body) as { start_cursor?: string }).start_cursor : undefined;
    if (cursor === undefined) return json({ results: [{ id: id(1), properties: { Name: { type: "title" } }, created_time: "2024-05-01T17:00:00.000Z" }], next_cursor: "c2" });
    return json({ results: [{ id: id(2), properties: {}, in_trash: true, created_time: "yesterday" }], next_cursor: null });
  });
  const result = await fetchNotionRows({ mode: "rows", token: TOKEN, sourceId: DB_DASHED, cursor: null }, { fetchImpl, ...fast });
  assert.deepEqual(result.source, { id: "ds-1", title: "作品库" });
  assert.deepEqual(result.rows.map((row) => row.id), [id(1), id(2)]);
  assert.equal(result.rows[1]!.inTrash, true);
  // Notion's creation instant comes along as metadata; a value that is not an ISO instant does not.
  assert.equal(result.rows[0]!.createdTime, "2024-05-01T17:00:00.000Z");
  assert.equal("createdTime" in result.rows[1]!, false);
  assert.equal(result.cursor, null);
  assert.deepEqual(paths, [`/v1/databases/${DB_DASHED}`, "/v1/data_sources/ds-1/query", "/v1/data_sources/ds-1/query"]);
});

test("a long listing hands back a cursor instead of running past the row budget", async () => {
  const { fetchImpl } = notion((path) => path.startsWith("/v1/databases/") ? json({ data_sources: [{ id: "ds" }] })
    : json({ results: Array.from({ length: 100 }, (_, n) => ({ id: id(n), properties: {} })), next_cursor: "more" }));
  const result = await fetchNotionRows({ mode: "rows", token: TOKEN, sourceId: DB_DASHED, cursor: null }, { fetchImpl, ...fast, limits: { minIntervalMs: 0, maxRows: 250 } });
  assert.equal(result.rows.length, 300);
  assert.equal(result.cursor, "more");
});

test("Notion's refusals become the endpoint's codes, with nothing of Notion's text", async () => {
  const cases: [number, string, Record<string, string>][] = [[401, "NOTION_TOKEN_INVALID", {}], [404, "NOTION_NOT_SHARED", {}], [403, "NOTION_NOT_SHARED", {}], [429, "NOTION_RATE_LIMITED", { "retry-after": "120" }], [500, "NOTION_UNAVAILABLE", {}], [400, "NOTION_UNAVAILABLE", {}]];
  for (const [status, code, headers] of cases) {
    const { fetchImpl } = notion((path) => path.startsWith("/v1/databases/") ? json({ data_sources: [{ id: "ds" }] }) : json({ message: "Notion said something private" }, status, headers));
    await assert.rejects(() => fetchNotionRows({ mode: "rows", token: TOKEN, sourceId: DB_DASHED, cursor: null }, { fetchImpl, ...fast }), (error: unknown) => {
      assert.ok(error instanceof NotionFetchError, `${status}`);
      assert.equal(error.code, code);
      assert.doesNotMatch(error.message, /private|ntn_/);
      if (status === 429) assert.equal(error.retryAfterSeconds, 120);
      return true;
    });
  }
});

test("page bodies come back in order; a page that cannot be carried is finished with an issue, never truncated", async () => {
  const { fetchImpl } = notion((path) => {
    if (path.startsWith(`/v1/blocks/${id(1)}/`)) return json({ results: [paragraph("一", 1), { ...paragraph("二", 2), has_children: true, id: "parent" }], next_cursor: null });
    if (path.startsWith("/v1/blocks/parent/")) return json({ results: [paragraph("子", 3)], next_cursor: null });
    if (path.startsWith(`/v1/blocks/${id(2)}/`)) return json({ results: Array.from({ length: 5 }, (_, n) => paragraph("长", n)), next_cursor: null });
    if (path.startsWith(`/v1/blocks/${id(3)}/`)) return json({ message: "no access" }, 404);
    if (path.startsWith(`/v1/blocks/${id(4)}/`)) return json({}, 502);
    return json({ results: [paragraph("末", 9)], next_cursor: null });
  });
  const result = await fetchNotionPages({ mode: "pages", token: TOKEN, pageIds: [id(1), id(2), id(3), id(4), id(5)] }, { fetchImpl, ...fast, limits: { minIntervalMs: 0, maxBlocksPerPage: 4 } });
  assert.deepEqual(result.pages.map((page) => page.id), [id(1), id(5)]);
  assert.deepEqual(result.pages[0]!.blocks.map((block) => block.id), ["b1", "parent", "b3"]);
  assert.equal("created_by" in result.pages[0]!.blocks[0]!, false, "audit fields are not carried");
  assert.deepEqual(result.issues, [{ id: id(2), code: "too-many-blocks" }, { id: id(3), code: "page-unavailable" }, { id: id(4), code: "fetch-failed" }]);
  assert.deepEqual(result.done, [id(1), id(2), id(3), id(4), id(5)]);
});

test("a slice ends at the byte budget and leaves the rest for the next request", async () => {
  const { fetchImpl } = notion(() => json({ results: [paragraph("x".repeat(400), 1)], next_cursor: null }));
  const result = await fetchNotionPages({ mode: "pages", token: TOKEN, pageIds: [id(1), id(2), id(3)] }, { fetchImpl, ...fast, limits: { minIntervalMs: 0, maxBytes: 1000 } });
  assert.deepEqual(result.done, [id(1), id(2)]);
  const tooBig = await fetchNotionPages({ mode: "pages", token: TOKEN, pageIds: [id(1)] }, { fetchImpl, ...fast, limits: { minIntervalMs: 0, maxBytes: 100 } });
  assert.deepEqual(tooBig.issues, [{ id: id(1), code: "page-too-large" }]);
});

test("a slice stops starting pages after the time budget, and abandons a page at the deadline", async () => {
  let clock = 0;
  const { fetchImpl } = notion(() => { clock += 20_000; return json({ results: [paragraph("x", 1)], next_cursor: null }); });
  const result = await fetchNotionPages({ mode: "pages", token: TOKEN, pageIds: [id(1), id(2), id(3), id(4)] }, { fetchImpl, now: () => clock, ...fast });
  assert.deepEqual(result.done, [id(1), id(2), id(3)], "the third page starts at 40 s; none starts at 60 s");

  clock = 0;
  const endless = notion(() => { clock += 30_000; return json({ results: [paragraph("x", 1)], next_cursor: "again" }); });
  const slow = await fetchNotionPages({ mode: "pages", token: TOKEN, pageIds: [id(1), id(2)] }, { fetchImpl: endless.fetchImpl, now: () => clock, ...fast });
  assert.deepEqual(slow.issues, [{ id: id(1), code: "fetch-timeout" }]);
  assert.deepEqual(slow.done, [id(1)]);
});

test("Notion's rate limit mid-slice keeps the finished pages and says how long to wait", async () => {
  let n = 0;
  const { fetchImpl } = notion(() => (++n === 1 ? json({ results: [], next_cursor: null }) : json({}, 429, { "retry-after": "60" })));
  const result = await fetchNotionPages({ mode: "pages", token: TOKEN, pageIds: [id(1), id(2)] }, { fetchImpl, ...fast });
  assert.deepEqual(result.done, [id(1)]);
  assert.equal(result.retryAfterSeconds, 60);

  const first = notion(() => json({}, 429, { "retry-after": "60" }));
  await assert.rejects(() => fetchNotionPages({ mode: "pages", token: TOKEN, pageIds: [id(1)] }, { fetchImpl: first.fetchImpl, ...fast }),
    (error: unknown) => error instanceof NotionFetchError && error.code === "NOTION_RATE_LIMITED" && error.retryAfterSeconds === 60);

  const refused = notion(() => json({}, 401));
  await assert.rejects(() => fetchNotionPages({ mode: "pages", token: TOKEN, pageIds: [id(1), id(2)] }, { fetchImpl: refused.fetchImpl, ...fast }),
    (error: unknown) => error instanceof NotionFetchError && error.code === "NOTION_TOKEN_INVALID");
});

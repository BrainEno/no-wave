import assert from "node:assert/strict";
import test from "node:test";
import {
  NOTION_PULL_MAX_WAITS,
  looksLikeNotionToken,
  notionFetchFailureMessage,
  pullNotionPages,
  pullNotionRows,
  withPulledBlocks,
  type FetchAnswer,
} from "./notion-fetch.ts";

/**
 * The browser's half of a Notion pull (ADR 0052): the loop that turns bounded
 * slices into one bundle. The server is a scripted list of answers, so each case
 * reads as the conversation it is.
 */

const TOKEN = "ntn_TESTONLY_paste_me_0123456789abcdef";
const ok = (data: unknown): FetchAnswer => ({ status: 200, payload: { data }, retryAfter: null });

function scripted(answers: (FetchAnswer | ((body: Record<string, unknown>) => FetchAnswer))[]) {
  const bodies: Record<string, unknown>[] = [];
  const progress: string[] = [];
  const slept: number[] = [];
  return {
    bodies, progress, slept,
    deps: {
      post: async (body: Record<string, unknown>) => {
        bodies.push(body);
        const next = answers.shift();
        assert.ok(next, `unexpected request ${JSON.stringify(body).replace(TOKEN, "<token>")}`);
        return typeof next === "function" ? next(body) : next;
      },
      onProgress: (message: string) => { progress.push(message); },
      sleep: async (ms: number) => { slept.push(ms); },
    },
  };
}

const row = (id: string, title: string) => ({ id, properties: { Name: { type: "title", title: [{ plain_text: title }] } } });

test("only a token's shape is checked before anything is sent, not its prefix", () => {
  assert.equal(looksLikeNotionToken(TOKEN), true);
  assert.equal(looksLikeNotionToken(`  ${TOKEN}  `), true);
  assert.equal(looksLikeNotionToken("secret_0123456789abcdefghij"), true);
  // Notion treats tokens as opaque; an OAuth access token's prefix is not documented.
  assert.equal(looksLikeNotionToken("nat_0123456789ABCDEFabcdef-._~+/=="), true);
  for (const value of [
    "", "ntn_short", "Bearer ntn_0123456789abcdefghij", "ntn_has space 0123456789abc", `ntn_${"a".repeat(500)}`,
    "https://www.notion.so/workspace/0123456789abcdef", "ntn_令牌_0123456789abcdefghij",
  ]) {
    assert.equal(looksLikeNotionToken(value), false, value);
  }
});

test("rows are listed across cursors into a bundle whose pages wait for their blocks", async () => {
  const server = scripted([
    ok({ source: { id: "ds-1", title: "作品库" }, rows: [{ ...row("p1", "墙壁"), createdTime: "2024-05-01T17:00:00.000Z" }, { ...row("p2", "旧作"), inTrash: true }], cursor: "c-2" }),
    ok({ source: { id: "ds-1", title: "作品库" }, rows: [row("p3", "诗")], cursor: null }),
  ]);
  const result = await pullNotionRows(TOKEN, "https://www.notion.so/x", server.deps);
  assert.ok(result.ok);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.bundle.database, { id: "ds-1", title: "作品库" });
  assert.deepEqual(result.bundle.pages.map((page) => [page.id, page.blocks, page.inTrash ?? false]), [["p1", [], false], ["p2", [], true], ["p3", [], false]]);
  // Creation instants stay beside the bundle — never inside it — for the optional Date backfill.
  assert.deepEqual([...result.created], [["p1", "2024-05-01T17:00:00.000Z"]]);
  assert.equal(result.bundle.pages.some((page) => "createdTime" in page), false);
  assert.deepEqual(server.bodies, [
    { token: TOKEN, mode: "rows", source: "https://www.notion.so/x" },
    { token: TOKEN, mode: "rows", source: "https://www.notion.so/x", cursor: "c-2" },
  ]);
});

test("pages are asked for again until every id is done, and a mid-slice limit is waited out", async () => {
  const server = scripted([
    ok({ pages: [{ id: "p1", blocks: [{ id: "b1" }] }], issues: [{ id: "p2", code: "too-many-blocks" }], done: ["p1", "p2"], retryAfterSeconds: 3 }),
    ok({ pages: [{ id: "p3", blocks: [] }], issues: [], done: ["p3"] }),
  ]);
  const result = await pullNotionPages(TOKEN, ["p1", "p2", "p3"], server.deps);
  assert.ok(result.ok);
  assert.deepEqual([...result.blocks.keys()], ["p1", "p3"]);
  assert.deepEqual(result.issues, [{ id: "p2", code: "too-many-blocks" }]);
  assert.deepEqual(server.bodies.map((body) => body.pageIds), [["p1", "p2", "p3"], ["p3"]]);
  assert.deepEqual(server.slept, [1000, 1000, 1000]);
  assert.ok(server.progress.some((line) => /3 秒后自动继续/.test(line)));
});

test("a 429 is waited out with its Retry-After, a bounded number of times", async () => {
  const limited: FetchAnswer = { status: 429, payload: { error: { code: "NOTION_RATE_LIMITED" } }, retryAfter: "2" };
  const recovered = scripted([limited, ok({ pages: [], issues: [{ id: "p1", code: "page-unavailable" }], done: ["p1"] })]);
  const result = await pullNotionPages(TOKEN, ["p1"], recovered.deps);
  assert.ok(result.ok);
  assert.deepEqual(recovered.slept, [1000, 1000]);

  const stuck = scripted(Array.from({ length: NOTION_PULL_MAX_WAITS + 1 }, () => limited));
  const failed = await pullNotionPages(TOKEN, ["p1"], stuck.deps);
  assert.equal(failed.ok, false);
  assert.match(failed.ok ? "" : failed.message, /请过几分钟再试/);
});

test("a server that finishes nothing ends the pull instead of looping", async () => {
  const server = scripted([ok({ pages: [], issues: [], done: [] })]);
  const result = await pullNotionPages(TOKEN, ["p1"], server.deps);
  assert.equal(result.ok, false);
});

test("an id marked done without a page or an issue is reported, never dropped silently", async () => {
  const server = scripted([ok({ pages: [], issues: [], done: ["p1"] })]);
  const result = await pullNotionPages(TOKEN, ["p1"], server.deps);
  assert.ok(result.ok);
  assert.deepEqual(result.issues, [{ id: "p1", code: "fetch-failed" }]);
});

test("stopping ends the pull between requests, and a network failure is a sentence", async () => {
  let stopped = false;
  const server = scripted([(body) => { stopped = true; return ok({ source: { id: "d", title: "" }, rows: [row("p1", "x")], cursor: "next", echo: body }); }]);
  const result = await pullNotionRows(TOKEN, "x", { ...server.deps, isStopped: () => stopped });
  assert.equal(result.ok, false);
  assert.equal(result.ok ? false : result.stopped, true);

  const offline = await pullNotionRows(TOKEN, "x", { post: async () => { throw new TypeError("Failed to fetch"); } });
  assert.equal(offline.ok, false);
  assert.match(offline.ok ? "" : offline.message, /网络中断/);
});

test("every refusal is a fixed sentence that never repeats the token", () => {
  const cases: [number, unknown][] = [
    [422, { error: { code: "NOTION_TOKEN_INVALID", message: TOKEN } }],
    [422, { error: { code: "NOTION_NOT_SHARED", message: TOKEN } }],
    [502, { error: { code: "NOTION_UNAVAILABLE", message: TOKEN } }],
    [409, { error: { code: "NOTION_FETCH_DISABLED", message: TOKEN } }],
    [401, { error: { code: "UNAUTHENTICATED", message: TOKEN } }],
    [500, { error: { code: "X", message: TOKEN } }],
  ];
  for (const [status, payload] of cases) assert.doesNotMatch(notionFetchFailureMessage(status, payload), new RegExp(TOKEN));
  assert.match(notionFetchFailureMessage(422, { error: { code: "NOTION_NOT_SHARED" } }), /连接/);
  assert.match(notionFetchFailureMessage(400, { error: { code: "BAD_USER_INPUT", message: "`source` must be a Notion link." } }), /source/);
});

test("blocks fill the pages they belong to without reordering the bundle", () => {
  const bundle = { version: 1, pages: [{ id: "a", blocks: [] }, { id: "b", blocks: [] }] };
  const filled = withPulledBlocks(bundle, new Map([["b", [{ id: "x" }]]]));
  assert.deepEqual(filled.pages, [{ id: "a", blocks: [] }, { id: "b", blocks: [{ id: "x" }] }]);
  assert.deepEqual(bundle.pages[1], { id: "b", blocks: [] }, "the input is not mutated");
});

test("the API's busy answer is waited out like a rate limit; a 503 without a Retry-After is a failure", async () => {
  const busy: FetchAnswer = { status: 503, payload: { error: { code: "SERVICE_UNAVAILABLE" } }, retryAfter: "5" };
  const server = scripted([busy, ok({ pages: [{ id: "p1", blocks: [] }], issues: [], done: ["p1"] })]);
  const result = await pullNotionPages(TOKEN, ["p1"], server.deps);
  assert.ok(result.ok);
  assert.equal(server.slept.length, 5);

  const down = scripted([{ status: 503, payload: null, retryAfter: null }]);
  const failed = await pullNotionPages(TOKEN, ["p1"], down.deps);
  assert.equal(failed.ok, false);
});

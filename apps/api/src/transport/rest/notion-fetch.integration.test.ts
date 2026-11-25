import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import { createApiServer } from "../../server.ts";
import { createSqliteClient, runSqliteMigrations } from "../../persistence/sqlite.ts";
import { createSqliteStore } from "../../persistence/sqlite-store.ts";
import { NOTION_FETCH_CONCURRENCY, setNotionFetchTransportForTests } from "./routes/imports.ts";
import { NOTION_API_ORIGIN, type NotionFetch } from "../../infrastructure/notion-source.ts";

/**
 * `POST /api/v1/imports/notion/fetch` over real HTTP (ADR 0052), with Notion
 * replaced by a stub so no test reaches api.notion.com.
 *
 * The assertion this file exists for is the last one of each case: whatever the
 * outcome, neither the pasted token nor Notion's own error text appears in the
 * response, the API's log lines, or anything the process writes to stdout/stderr.
 */

const env = {
  AUTH_JWT_SECRET: "test-only-secret-at-least-thirty-two-bytes",
  AUTH_JWT_ISSUER: "https://auth.example.test",
  AUTH_JWT_AUDIENCE: "no-wave-api",
};
const NOTION_TOKEN = "ntn_TESTONLY_paste_me_0123456789abcdef";
const NOTION_SECRET_TEXT = "PRIVATE-NOTION-ERROR-TEXT";
const DB = "0123456789abcdef0123456789abcdef";

function bearer(sub: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "application/vnd.no-wave.access+jwt" });
  const payload = encode({ sub, iss: env.AUTH_JWT_ISSUER, aud: env.AUTH_JWT_AUDIENCE,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, sid: `session-${sub}`, jti: `token-${sub}` });
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${createHmac("sha256", env.AUTH_JWT_SECRET).update(unsigned).digest("base64url")}`;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return { status, ok: status >= 200 && status < 300, json: async () => body, headers: new Headers(headers) };
}

async function withServer(extraEnv: Record<string, string>, run: (post: (body: unknown, actor?: string | null) => Promise<{ status: number; headers: Headers; text: string }>, logs: string[]) => Promise<void>) {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  await runSqliteMigrations(db);
  const logs: string[] = [];
  const server = createApiServer({ store: createSqliteStore(db), env: { ...env, ...extraEnv }, logger: (line: unknown) => { logs.push(typeof line === "string" ? line : JSON.stringify(line)); } });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}/api/v1/imports/notion/fetch`;
  const actor = `fetch-author-${randomUUID().slice(0, 8)}`;
  // Anything the process prints while a request is handled counts as a log.
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => { logs.push(String(chunk)); return out(chunk as string, ...(rest as [])); }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => { logs.push(String(chunk)); return err(chunk as string, ...(rest as [])); }) as typeof process.stderr.write;
  try {
    await run(async (body, who = actor) => {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(who ? { authorization: `Bearer ${bearer(who)}` } : {}) }, body: JSON.stringify(body) });
      return { status: response.status, headers: response.headers, text: await response.text() };
    }, logs);
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
    setNotionFetchTransportForTests(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

function assertNoSecrets(where: string, ...texts: string[]) {
  for (const text of texts) {
    assert.doesNotMatch(text, new RegExp(NOTION_TOKEN), `${where} must not contain the token`);
    assert.doesNotMatch(text, new RegExp(NOTION_SECRET_TEXT), `${where} must not contain Notion's error text`);
  }
}

test("a signed-in author lists rows and reads pages; the token goes to Notion and nowhere else", async () => {
  const seen: { url: string; authorization: string }[] = [];
  setNotionFetchTransportForTests(async (url, init) => {
    seen.push({ url, authorization: init.headers.authorization ?? "" });
    const path = url.replace(NOTION_API_ORIGIN, "");
    if (path.startsWith("/v1/databases/")) return json({ data_sources: [{ id: "ds-1", name: "作品库" }] });
    if (path.startsWith("/v1/data_sources/")) return json({ results: [{ id: "00000001-0000-4000-8000-000000000000", properties: { Name: { type: "title", title: [{ plain_text: "墙壁" }] } } }], next_cursor: null });
    return json({ results: [{ id: "b1", type: "paragraph", has_children: false, paragraph: { rich_text: [{ plain_text: "正文" }] } }], next_cursor: null });
  });
  await withServer({}, async (post, logs) => {
    const rows = await post({ token: NOTION_TOKEN, mode: "rows", source: `https://www.notion.so/me/Works-${DB}?v=ffffffffffffffffffffffffffffffff` });
    assert.equal(rows.status, 200, rows.text);
    assert.equal(rows.headers.get("cache-control"), "no-store");
    const listed = JSON.parse(rows.text).data;
    assert.deepEqual(listed.source, { id: "ds-1", title: "作品库" });
    assert.equal(listed.rows.length, 1);

    const pages = await post({ token: NOTION_TOKEN, mode: "pages", pageIds: [listed.rows[0].id] });
    assert.equal(pages.status, 200, pages.text);
    const read = JSON.parse(pages.text).data;
    assert.deepEqual(read.done, [listed.rows[0].id]);
    assert.equal(read.pages[0].blocks[0].id, "b1");

    assert.ok(seen.every((call) => call.authorization === `Bearer ${NOTION_TOKEN}`));
    assert.ok(seen.some((call) => call.url.includes("01234567-89ab-cdef-0123-456789abcdef")), "the database id, not the view id");
    assertNoSecrets("responses and logs", rows.text, pages.text, ...logs);
  });
});

test("Notion's refusals are answered with stable codes and Retry-After, never with Notion's text", async () => {
  let answer = json({ message: NOTION_SECRET_TEXT }, 401);
  setNotionFetchTransportForTests(async () => answer);
  await withServer({}, async (post, logs) => {
    const cases: [ReturnType<typeof json>, number, string][] = [
      [json({ message: NOTION_SECRET_TEXT }, 401), 422, "NOTION_TOKEN_INVALID"],
      [json({ message: NOTION_SECRET_TEXT }, 404), 422, "NOTION_NOT_SHARED"],
      [json({ message: NOTION_SECRET_TEXT }, 429, { "retry-after": "77" }), 429, "NOTION_RATE_LIMITED"],
      [json({ message: NOTION_SECRET_TEXT }, 503), 502, "NOTION_UNAVAILABLE"],
    ];
    const texts: string[] = [];
    for (const [notionAnswer, status, code] of cases) {
      answer = notionAnswer;
      // A listing fails as a whole; in `pages` mode a 404 is only that page's issue.
      const result = await post({ token: NOTION_TOKEN, mode: "rows", source: DB });
      texts.push(result.text);
      assert.equal(result.status, status, result.text);
      assert.equal(JSON.parse(result.text).error.code, code);
      if (status === 429) assert.equal(result.headers.get("retry-after"), "77");
    }
    // A transport that throws something unexpected (with the token in it) is still opaque.
    setNotionFetchTransportForTests((async () => { throw new Error(`boom ${NOTION_TOKEN} ${NOTION_SECRET_TEXT}`); }) as NotionFetch);
    const thrown = await post({ token: NOTION_TOKEN, mode: "rows", source: DB });
    assert.equal(thrown.status, 502);
    assertNoSecrets("responses and logs", thrown.text, ...texts, ...logs);
  });
});

test("the pull needs a session and a well-formed request, and can be switched off", async () => {
  let called = 0;
  setNotionFetchTransportForTests(async () => { called += 1; return json({}); });
  await withServer({}, async (post, logs) => {
    const anonymous = await post({ token: NOTION_TOKEN, mode: "rows", source: DB }, null);
    assert.equal(anonymous.status, 401);
    // Only the shape is checked (the prefix is opaque), so a value that could not be
    // one Authorization header is the malformed case.
    const badToken = await post({ token: "sk-live NOT-A-NOTION-TOKEN-0123456789", mode: "rows", source: DB });
    assert.equal(badToken.status, 400);
    assert.doesNotMatch(badToken.text, /sk-live/);
    const badSource = await post({ token: NOTION_TOKEN, mode: "rows", source: "https://example.com/x" });
    assert.equal(badSource.status, 400);
    const badMode = await post({ token: NOTION_TOKEN, mode: "search", query: "x" });
    assert.equal(badMode.status, 400);
    assert.equal(called, 0, "nothing reaches Notion before the request is valid");
    assertNoSecrets("responses and logs", anonymous.text, badSource.text, badMode.text, ...logs);
  });
  await withServer({ NOTION_FETCH_ENABLED: "false" }, async (post) => {
    const disabled = await post({ token: NOTION_TOKEN, mode: "rows", source: DB });
    assert.equal(disabled.status, 409);
    assert.equal(JSON.parse(disabled.text).error.code, "NOTION_FETCH_DISABLED");
    assert.equal(called, 0);
  });
});

test("pulling has its own rate limit, separate from importing", async () => {
  setNotionFetchTransportForTests(async () => json({ results: [], next_cursor: null }));
  await withServer({}, async (post) => {
    const statuses: number[] = [];
    for (let index = 0; index < 61; index += 1) statuses.push((await post({ token: NOTION_TOKEN, mode: "pages", pageIds: ["00000001-0000-4000-8000-000000000000"] })).status);
    assert.equal(statuses.filter((status) => status === 200).length, 60);
    assert.equal(statuses.at(-1), 429);
  });
});

test("an author holds at most two pulls open at once; the third is told when to come back", async () => {
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => { unblock = resolve; });
  let started = 0;
  setNotionFetchTransportForTests(async () => { started += 1; await gate; return json({ results: [], next_cursor: null }); });
  await withServer({}, async (post) => {
    const body = { token: NOTION_TOKEN, mode: "pages", pageIds: ["00000001-0000-4000-8000-000000000000"] };
    const held = [post(body), post(body)];
    while (started < NOTION_FETCH_CONCURRENCY.perActor) await new Promise((resolve) => setTimeout(resolve, 10));
    const busy = await post(body);
    assert.equal(busy.status, 503);
    assert.equal(JSON.parse(busy.text).error.code, "NOTION_FETCH_BUSY");
    assert.equal(busy.headers.get("retry-after"), String(NOTION_FETCH_CONCURRENCY.retryAfterSeconds));
    // Another author is not held back by this one.
    const other = post(body, `other-${randomUUID().slice(0, 8)}`);
    unblock();
    assert.deepEqual((await Promise.all([...held, other])).map((result) => result.status), [200, 200, 200]);
    // Slots are released when a pull ends, whatever its outcome.
    assert.equal((await post(body)).status, 200);
  });
});

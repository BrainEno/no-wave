import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import { createApiServer } from "../../server.ts";
import { createSqliteClient, runSqliteMigrations } from "../../persistence/sqlite.ts";
import { createSqliteStore } from "../../persistence/sqlite-store.ts";
import { setNotionOAuthTransportForTests } from "./routes/imports.ts";
import type { NotionFetch } from "../../infrastructure/notion-source.ts";

/**
 * One-shot Notion OAuth over real HTTP (ADR 0053), with Notion's token endpoint
 * replaced by a stub so no test reaches api.notion.com.
 *
 * As with the pull, the closing assertion of each case is the point: neither the
 * code, the client secret, the access or refresh token nor Notion's error text
 * appears in a response other than the one grant, or in anything the process logs.
 */

const env = {
  AUTH_JWT_SECRET: "test-only-secret-at-least-thirty-two-bytes",
  AUTH_JWT_ISSUER: "https://auth.example.test",
  AUTH_JWT_AUDIENCE: "no-wave-api",
};
const OAUTH_ENV = {
  NOTION_OAUTH_CLIENT_ID: "client-id-0001",
  NOTION_OAUTH_CLIENT_SECRET: "TESTONLY-CLIENT-SECRET",
  NOTION_OAUTH_REDIRECT_URI: "https://wave.example/write/notion/oauth/callback",
};
const CODE = "TESTONLY-CODE-0001";
const ACCESS = "ntn_TESTONLY_oauth_access_0123456789";
const REFRESH = "nrt_TESTONLY_refresh_0123456789";
const NOTION_TEXT = "PRIVATE-NOTION-ERROR-TEXT";

function bearer(sub: string): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "HS256", typ: "application/vnd.no-wave.access+jwt" });
  const payload = encode({ sub, iss: env.AUTH_JWT_ISSUER, aud: env.AUTH_JWT_AUDIENCE,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, sid: `session-${sub}`, jti: `token-${sub}` });
  const unsigned = `${header}.${payload}`;
  return `${unsigned}.${createHmac("sha256", env.AUTH_JWT_SECRET).update(unsigned).digest("base64url")}`;
}

type Call = (method: "GET" | "POST", path: string, body?: unknown, actor?: string | null) => Promise<{ status: number; headers: Headers; text: string; json: () => any }>;

async function withServer(extraEnv: Record<string, string>, run: (call: Call, logs: string[], actor: string) => Promise<void>) {
  const db = createSqliteClient({ filename: ":memory:", enableWal: false });
  await runSqliteMigrations(db);
  const logs: string[] = [];
  const server = createApiServer({ store: createSqliteStore(db), env: { ...env, ...extraEnv }, logger: (line: unknown) => { logs.push(typeof line === "string" ? line : JSON.stringify(line)); } });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/api/v1/imports/notion/oauth`;
  const actor = `oauth-author-${randomUUID().slice(0, 8)}`;
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => { logs.push(String(chunk)); return out(chunk as string, ...(rest as [])); }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => { logs.push(String(chunk)); return err(chunk as string, ...(rest as [])); }) as typeof process.stderr.write;
  try {
    await run(async (method, path, body, who = actor) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(who ? { authorization: `Bearer ${bearer(who)}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, headers: response.headers, text, json: () => JSON.parse(text) };
    }, logs, actor);
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
    setNotionOAuthTransportForTests(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  }
}

function assertNoSecrets(where: string, ...texts: string[]) {
  for (const text of texts) {
    for (const secret of [CODE, ACCESS, REFRESH, NOTION_TEXT, OAUTH_ENV.NOTION_OAUTH_CLIENT_SECRET]) {
      assert.ok(!text.includes(secret), `${where} must not contain ${secret.slice(0, 12)}…`);
    }
  }
}

function notion(status: number, body: unknown) {
  const seen: { url: string; authorization: string; body: string }[] = [];
  const transport: NotionFetch = async (url, init) => {
    seen.push({ url, authorization: init.headers.authorization ?? "", body: init.body ?? "" });
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  };
  setNotionOAuthTransportForTests(transport);
  return seen;
}

test("start, then exchange: the author gets the access token once, and the refresh token never leaves Notion's answer", async () => {
  const seen = notion(200, { access_token: ACCESS, token_type: "bearer", refresh_token: REFRESH, bot_id: "b", workspace_id: "w", workspace_name: "作者的工作区", owner: { type: "user" } });
  await withServer(OAUTH_ENV, async (call, logs) => {
    const status = await call("GET", "");
    assert.equal(status.status, 200);
    assert.deepEqual(status.json(), { data: { enabled: true } });

    const started = await call("POST", "/start");
    assert.equal(started.status, 200);
    assert.equal(started.headers.get("cache-control"), "no-store");
    const { authorizeUrl, state } = started.json().data;
    assert.equal(new URL(authorizeUrl).searchParams.get("state"), state);
    assert.doesNotMatch(started.text, /TESTONLY-CLIENT-SECRET/);

    const granted = await call("POST", "/exchange", { code: CODE, state });
    assert.equal(granted.status, 200);
    assert.equal(granted.headers.get("cache-control"), "no-store");
    assert.deepEqual(granted.json(), { data: { accessToken: ACCESS, workspaceName: "作者的工作区" } });
    assert.doesNotMatch(granted.text, /nrt_/);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.url, "https://api.notion.com/v1/oauth/token");
    assert.equal(JSON.parse(seen[0]!.body).code, CODE);

    // The same state cannot be redeemed twice, even with a fresh code.
    const replay = await call("POST", "/exchange", { code: "TESTONLY-CODE-0002", state });
    assert.equal(replay.status, 422);
    assert.equal(replay.json().error.code, "NOTION_OAUTH_STATE_INVALID");
    assert.equal(seen.length, 1, "a replay never reaches Notion");
    assertNoSecrets("logs", ...logs);
  });
});

test("a state started by another author, a forged state and Notion's refusals are all answered without repeating anything", async () => {
  await withServer(OAUTH_ENV, async (call, logs) => {
    const seen = notion(400, { error: "invalid_grant", error_description: NOTION_TEXT });
    const theirs = (await call("POST", "/start", undefined, `other-${randomUUID().slice(0, 8)}`)).json().data.state;
    const stolen = await call("POST", "/exchange", { code: CODE, state: theirs });
    assert.equal(stolen.status, 422);
    assert.equal(stolen.json().error.code, "NOTION_OAUTH_STATE_INVALID");
    const forged = await call("POST", "/exchange", { code: CODE, state: "v1.9999999999.forged.forged" });
    assert.equal(forged.status, 422);
    assert.equal(seen.length, 0, "nothing reaches Notion without a valid state");

    const expired = await call("POST", "/exchange", { code: CODE, state: (await call("POST", "/start")).json().data.state });
    assert.equal(expired.status, 422);
    assert.equal(expired.json().error.code, "NOTION_OAUTH_CODE_INVALID");

    notion(401, { error: "invalid_client", error_description: NOTION_TEXT });
    const misconfigured = await call("POST", "/exchange", { code: CODE, state: (await call("POST", "/start")).json().data.state });
    assert.equal(misconfigured.status, 502);
    assert.equal(misconfigured.json().error.code, "NOTION_OAUTH_MISCONFIGURED");

    const malformed = await call("POST", "/exchange", { code: `${CODE} with spaces`, state: "x" });
    assert.equal(malformed.status, 400);
    assertNoSecrets("responses and logs", stolen.text, forged.text, expired.text, misconfigured.text, malformed.text, ...logs);
  });
});

test("OAuth needs a session, is off without its settings, and has its own rate limit", async () => {
  const seen = notion(200, { access_token: ACCESS });
  await withServer({}, async (call) => {
    assert.deepEqual((await call("GET", "")).json(), { data: { enabled: false } });
    const start = await call("POST", "/start");
    assert.equal(start.status, 409);
    assert.equal(start.json().error.code, "NOTION_OAUTH_DISABLED");
    assert.equal((await call("POST", "/exchange", { code: CODE, state: "x" })).status, 409);
  });
  await withServer({ ...OAUTH_ENV, NOTION_FETCH_ENABLED: "false" }, async (call) => {
    assert.deepEqual((await call("GET", "")).json(), { data: { enabled: false } });
  });
  await withServer(OAUTH_ENV, async (call) => {
    assert.equal((await call("GET", "", undefined, null)).status, 401);
    assert.equal((await call("POST", "/start", undefined, null)).status, 401);
    assert.equal((await call("POST", "/exchange", { code: CODE, state: "x" }, null)).status, 401);
    const statuses: number[] = [];
    for (let index = 0; index < 11; index += 1) statuses.push((await call("POST", "/start")).status);
    assert.equal(statuses.filter((status) => status === 200).length, 10);
    assert.equal(statuses.at(-1), 429);
  });
  assert.equal(seen.length, 0);
});

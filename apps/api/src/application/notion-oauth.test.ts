import assert from "node:assert/strict";
import test from "node:test";
import {
  NOTION_OAUTH_LIMITS,
  NotionOAuthError,
  NotionOAuthRequestError,
  consumeNotionOAuthState,
  createUsedStates,
  exchangeNotionOAuthCode,
  readNotionOAuthConfig,
  readNotionOAuthExchange,
  startNotionOAuth,
} from "./notion-oauth.ts";
import type { NotionFetch } from "../infrastructure/notion-source.ts";

const ENV = {
  NOTION_OAUTH_CLIENT_ID: "client-id-0001",
  NOTION_OAUTH_CLIENT_SECRET: "TESTONLY-client-secret-value",
  NOTION_OAUTH_REDIRECT_URI: "https://wave.example/write/notion/oauth/callback",
};
const config = readNotionOAuthConfig(ENV)!;
const NOW = 1_800_000_000_000;

test("OAuth is on only with all three settings and a redirect URI that is exactly the callback page", () => {
  assert.deepEqual(config, { clientId: "client-id-0001", clientSecret: "TESTONLY-client-secret-value", redirectUri: ENV.NOTION_OAUTH_REDIRECT_URI });
  assert.ok(readNotionOAuthConfig({ ...ENV, NOTION_OAUTH_REDIRECT_URI: "http://127.0.0.1:3100/write/notion/oauth/callback" }), "plain http on loopback, for local development");
  for (const broken of [
    { NOTION_OAUTH_CLIENT_ID: "" },
    { NOTION_OAUTH_CLIENT_SECRET: "  " },
    { NOTION_OAUTH_REDIRECT_URI: undefined },
    { NOTION_OAUTH_REDIRECT_URI: "http://wave.example/write/notion/oauth/callback" },
    { NOTION_OAUTH_REDIRECT_URI: "https://wave.example/elsewhere" },
    { NOTION_OAUTH_REDIRECT_URI: "https://wave.example/write/notion/oauth/callback?next=/x" },
    { NOTION_OAUTH_REDIRECT_URI: "https://user:pw@wave.example/write/notion/oauth/callback" },
    { NOTION_OAUTH_REDIRECT_URI: "not a url" },
    { NOTION_FETCH_ENABLED: "false" },
  ]) assert.equal(readNotionOAuthConfig({ ...ENV, ...broken }), null, JSON.stringify(broken));
});

test("start builds Notion's authorize URL with a state that only this author can redeem, once, within ten minutes", () => {
  const started = startNotionOAuth(config, "author-1", NOW);
  const url = new URL(started.authorizeUrl);
  assert.equal(url.origin + url.pathname, "https://api.notion.com/v1/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "client-id-0001");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("owner"), "user");
  assert.equal(url.searchParams.get("redirect_uri"), ENV.NOTION_OAUTH_REDIRECT_URI);
  assert.equal(url.searchParams.get("state"), started.state);
  assert.equal(started.expiresInSeconds, NOTION_OAUTH_LIMITS.stateTtlSeconds);
  // Nothing about the author or the secret is readable from the state.
  assert.doesNotMatch(started.state, /author-1|TESTONLY/);
  assert.notEqual(startNotionOAuth(config, "author-1", NOW).state, started.state, "every start is fresh");

  const refused = (fn: () => void) => assert.throws(fn, (error: unknown) => error instanceof NotionOAuthError && error.code === "NOTION_OAUTH_STATE_INVALID");
  const used = createUsedStates();
  refused(() => consumeNotionOAuthState(config, "author-2", started.state, used, NOW));
  refused(() => consumeNotionOAuthState(config, "author-1", started.state, used, NOW + 601_000));
  refused(() => consumeNotionOAuthState(readNotionOAuthConfig({ ...ENV, NOTION_OAUTH_CLIENT_SECRET: "rotated-secret" })!, "author-1", started.state, used, NOW));
  refused(() => consumeNotionOAuthState(config, "author-1", started.state.slice(0, -2) + "AA", used, NOW));
  refused(() => consumeNotionOAuthState(config, "author-1", "v1.9999999999.x.y", used, NOW));
  consumeNotionOAuthState(config, "author-1", started.state, used, NOW + 30_000);
  refused(() => consumeNotionOAuthState(config, "author-1", started.state, used, NOW + 31_000));
  // Spent states are forgotten once they would have expired anyway.
  consumeNotionOAuthState(config, "author-1", startNotionOAuth(config, "author-1", NOW + 700_000).state, used, NOW + 700_000);
  assert.equal(used.size, 1);
});

test("the exchange body names the wrong field and never repeats its value", () => {
  assert.deepEqual(readNotionOAuthExchange({ code: "c0de-0001", state: "s" }), { code: "c0de-0001", state: "s" });
  for (const body of [{ state: "s" }, { code: "", state: "s" }, { code: "has space SECRETCODE", state: "s" }, { code: "x".repeat(513), state: "s" }, { code: "ok", state: 1 }]) {
    assert.throws(() => readNotionOAuthExchange(body), (error: unknown) => error instanceof NotionOAuthRequestError && !/SECRETCODE/.test(error.message));
  }
});

function stub(status: number, body: unknown) {
  const calls: { url: string; init: Parameters<NotionFetch>[1] }[] = [];
  const fetchImpl: NotionFetch = async (url, init) => {
    calls.push({ url, init });
    return { status, ok: status >= 200 && status < 300, json: async () => body };
  };
  return { calls, fetchImpl };
}

test("the code is redeemed with Basic client credentials and only the access token and workspace name come back", async () => {
  const notion = stub(200, {
    access_token: "ntn_TESTONLY_oauth_access_0123456789", token_type: "bearer", refresh_token: "nrt_TESTONLY_refresh_0123456789",
    bot_id: "b", workspace_id: "w", workspace_name: " 我的\u0007工作区 ", owner: { type: "user" },
  });
  const grant = await exchangeNotionOAuthCode(config, "c0de-0001", notion.fetchImpl);
  assert.deepEqual(grant, { accessToken: "ntn_TESTONLY_oauth_access_0123456789", workspaceName: "我的工作区" });
  assert.doesNotMatch(JSON.stringify(grant), /nrt_/);
  const [call] = notion.calls;
  assert.equal(call!.url, "https://api.notion.com/v1/oauth/token");
  assert.equal(call!.init.method, "POST");
  assert.equal(call!.init.headers.authorization, `Basic ${Buffer.from("client-id-0001:TESTONLY-client-secret-value").toString("base64")}`);
  assert.deepEqual(JSON.parse(call!.init.body!), { grant_type: "authorization_code", code: "c0de-0001", redirect_uri: ENV.NOTION_OAUTH_REDIRECT_URI });
});

test("Notion's refusals become fixed codes that carry nothing of Notion's text", async () => {
  const cases: [number, unknown, string][] = [
    [400, { error: "invalid_grant", error_description: "PRIVATE-NOTION-TEXT" }, "NOTION_OAUTH_CODE_INVALID"],
    [400, { object: "error", code: "invalid_grant", message: "PRIVATE-NOTION-TEXT" }, "NOTION_OAUTH_CODE_INVALID"],
    [401, { error: "invalid_client" }, "NOTION_OAUTH_MISCONFIGURED"],
    [400, { error: "unauthorized_client" }, "NOTION_OAUTH_MISCONFIGURED"],
    [500, null, "NOTION_UNAVAILABLE"],
    [200, { access_token: "has space in it 0123456789" }, "NOTION_UNAVAILABLE"],
    [200, { refresh_token: "nrt_only" }, "NOTION_UNAVAILABLE"],
  ];
  for (const [status, body, code] of cases) {
    await assert.rejects(() => exchangeNotionOAuthCode(config, "c0de-0001", stub(status, body).fetchImpl), (error: unknown) =>
      error instanceof NotionOAuthError && error.code === code && !/PRIVATE|c0de|TESTONLY/.test(error.message));
  }
  await assert.rejects(() => exchangeNotionOAuthCode(config, "c0de-0001", async () => { throw new Error("socket TESTONLY"); }),
    (error: unknown) => error instanceof NotionOAuthError && error.code === "NOTION_UNAVAILABLE");
});

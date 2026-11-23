import assert from "node:assert/strict";
import test from "node:test";
import {
  NOTION_OAUTH_DENIED_MESSAGE,
  announceNotionOAuth,
  exchangeNotionOAuthCode,
  notionOAuthChannelName,
  notionOAuthFailureMessage,
  parseNotionOAuthCallback,
  readNotionOAuthMessage,
  startNotionOAuth,
  waitForNotionOAuth,
  type ChannelFactory,
  type ChannelLike,
  type JsonPost,
} from "./notion-oauth.ts";

const TOKEN = "ntn_TESTONLY_oauth_access_0123456789";

/** An in-memory BroadcastChannel: every channel with the same name hears the others. */
function channels() {
  const open = new Map<string, Set<ChannelLike>>();
  const factory: ChannelFactory = (name) => {
    const peers = open.get(name) ?? new Set<ChannelLike>();
    open.set(name, peers);
    const channel: ChannelLike = {
      onmessage: null,
      postMessage(message) { for (const peer of peers) if (peer !== channel) peer.onmessage?.({ data: structuredClone(message) }); },
      close() { peers.delete(channel); },
    };
    peers.add(channel);
    return channel;
  };
  return { factory, listeners: (name: string) => open.get(name)?.size ?? 0 };
}

test("the callback URL is read as a code, a refusal, or nothing usable", () => {
  assert.deepEqual(parseNotionOAuthCallback("?code=c-1&state=s-1"), { kind: "code", code: "c-1", state: "s-1" });
  assert.deepEqual(parseNotionOAuthCallback("?error=access_denied&state=s-1"), { kind: "denied", state: "s-1" });
  assert.deepEqual(parseNotionOAuthCallback("?error=access_denied"), { kind: "denied", state: null });
  for (const search of ["", "?code=c-1", "?state=s-1", `?code=c&state=${"s".repeat(201)}`, `?code=${"c".repeat(513)}&state=s`]) {
    assert.deepEqual(parseNotionOAuthCallback(search), { kind: "invalid" }, search);
  }
});

test("only the callback's own message shapes are accepted from the channel", () => {
  assert.deepEqual(readNotionOAuthMessage({ kind: "notion-oauth", ok: true, token: TOKEN, workspaceName: "W" }), { kind: "notion-oauth", ok: true, token: TOKEN, workspaceName: "W" });
  assert.deepEqual(readNotionOAuthMessage({ kind: "notion-oauth", ok: true, token: TOKEN, workspaceName: "  " }), { kind: "notion-oauth", ok: true, token: TOKEN, workspaceName: null });
  assert.deepEqual(readNotionOAuthMessage({ kind: "notion-oauth", ok: false, message: "no" }), { kind: "notion-oauth", ok: false, message: "no" });
  for (const data of [null, "token", { kind: "other", ok: true, token: TOKEN }, { kind: "notion-oauth", ok: true, token: "" }, { kind: "notion-oauth", ok: "yes", token: TOKEN }, { kind: "notion-oauth", ok: false }]) {
    assert.equal(readNotionOAuthMessage(data), null, JSON.stringify(data));
  }
});

test("the desk hears only the authorization it started, takes the first answer, and closes the channel", async () => {
  const bus = channels();
  const wait = waitForNotionOAuth("state-mine", { channel: bus.factory, timeoutMs: 10_000 });
  // Another authorization's answer, and noise on this channel, are ignored.
  announceNotionOAuth("state-other", { kind: "notion-oauth", ok: true, token: "ntn_not_for_this_desk_000000", workspaceName: null }, bus.factory);
  bus.factory(notionOAuthChannelName("state-mine")).postMessage({ kind: "something-else" });
  announceNotionOAuth("state-mine", { kind: "notion-oauth", ok: true, token: TOKEN, workspaceName: "作者的工作区" }, bus.factory);
  assert.deepEqual(await wait.result, { kind: "notion-oauth", ok: true, token: TOKEN, workspaceName: "作者的工作区" });
  assert.equal(bus.listeners(notionOAuthChannelName("state-mine")), 1, "only the stray sender above is left; the desk closed its end");
});

test("a cancelled or timed-out wait resolves to null and stops listening", async () => {
  const bus = channels();
  const cancelled = waitForNotionOAuth("s-1", { channel: bus.factory, timeoutMs: 10_000 });
  cancelled.cancel();
  assert.equal(await cancelled.result, null);
  assert.equal(bus.listeners(notionOAuthChannelName("s-1")), 0);
  const timedOut = waitForNotionOAuth("s-2", { channel: bus.factory, timeoutMs: 5 });
  assert.equal(await timedOut.result, null);
  announceNotionOAuth("s-2", { kind: "notion-oauth", ok: true, token: TOKEN, workspaceName: null }, bus.factory);
});

function poster(status: number, payload: unknown) {
  const calls: { url: string; body: unknown }[] = [];
  const post: JsonPost = async (url, body) => { calls.push({ url, body }); return { status, payload }; };
  return { calls, post };
}

test("start accepts only a Notion authorize URL; exchange turns the API's answer into the desk's message", async () => {
  const good = poster(200, { data: { authorizeUrl: "https://api.notion.com/v1/oauth/authorize?client_id=x&state=s", state: "s", expiresInSeconds: 600 } });
  assert.deepEqual(await startNotionOAuth(good.post), { ok: true, authorizeUrl: "https://api.notion.com/v1/oauth/authorize?client_id=x&state=s", state: "s" });
  assert.deepEqual(good.calls, [{ url: "/api/authoring/notion-oauth/start", body: {} }]);
  const elsewhere = await startNotionOAuth(poster(200, { data: { authorizeUrl: "https://evil.example/authorize?", state: "s" } }).post);
  assert.equal(elsewhere.ok, false);
  const disabled = await startNotionOAuth(poster(409, { error: { code: "NOTION_OAUTH_DISABLED" } }).post);
  assert.deepEqual(disabled, { ok: false, message: "本站没有配置 Notion 授权，请改用粘贴令牌。" });

  const exchanged = poster(200, { data: { accessToken: TOKEN, workspaceName: "W" } });
  assert.deepEqual(await exchangeNotionOAuthCode("c-1", "s-1", exchanged.post), { kind: "notion-oauth", ok: true, token: TOKEN, workspaceName: "W" });
  assert.deepEqual(exchanged.calls, [{ url: "/api/authoring/notion-oauth/exchange", body: { code: "c-1", state: "s-1" } }]);
  const refused = await exchangeNotionOAuthCode("c-1", "s-1", poster(422, { error: { code: "NOTION_OAUTH_STATE_INVALID", message: "c-1" } }).post);
  assert.equal(refused.ok, false);
  assert.match(refused.ok ? "" : refused.message, /已过期、已用过/);
});

test("every failure is a fixed sentence that never repeats what the API or Notion said", () => {
  const sentences = [
    notionOAuthFailureMessage(409, { error: { code: "NOTION_OAUTH_DISABLED", message: "SECRET" } }),
    notionOAuthFailureMessage(422, { error: { code: "NOTION_OAUTH_CODE_INVALID", message: "SECRET" } }),
    notionOAuthFailureMessage(502, { error: { code: "NOTION_OAUTH_MISCONFIGURED", message: "SECRET" } }),
    notionOAuthFailureMessage(502, { error: { code: "NOTION_UNAVAILABLE", message: "SECRET" } }),
    notionOAuthFailureMessage(401, null),
    notionOAuthFailureMessage(429, null),
    notionOAuthFailureMessage(0, null),
    notionOAuthFailureMessage(500, { error: { message: "SECRET" } }),
    NOTION_OAUTH_DENIED_MESSAGE,
  ];
  for (const sentence of sentences) assert.doesNotMatch(sentence, /SECRET/);
  assert.equal(new Set(sentences).size, sentences.length);
});

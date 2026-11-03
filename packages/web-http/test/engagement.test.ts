import assert from "node:assert/strict";
import test from "node:test";

import {
  ENGAGEMENT_DEFAULT_LOCALE,
  articleLikePath,
  handleArticleLikeRequest,
  handleUserFollowRequest,
  userFollowPath,
} from "../src/engagement.ts";
import { API_BASE, TOKENS, assertNoStore, json, request, stubFetch } from "./helpers.ts";

/**
 * 收藏与关注代理（issue #168）。
 *
 * 这些断言关心的不是 SQL，而是浏览器这一侧的三件事：读者动作必须带上 cookie
 * 换来的 Bearer 头、必须来自本站、`PUT` 只接受一个布尔值。其余都在 API 那边
 * 已有自己的契约测试。
 */

const SLUG = "a-portable-web";
const USER_ID = "author-0001";

function likeRequest(method: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return request(`/api/articles/${SLUG}/like?locale=zh-CN`, {
    method,
    headers: {
      host: "no-wave.test",
      origin: "https://no-wave.test",
      cookie: `nw_access=${TOKENS.accessToken}; nw_session=1`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test("收藏的 GET 是公开读，并带上读者自己的身份", async () => {
  const upstream = stubFetch({ "api/v1/articles/": () => json({ data: { likeCount: 3, likedByViewer: true } }) });
  const response = await handleArticleLikeRequest(likeRequest("GET"), { slug: SLUG }, { apiBaseUrl: API_BASE, fetchImpl: upstream.fetchImpl });
  assert.equal(response.status, 200);
  assert.equal(upstream.calls.length, 1);
  assert.equal(upstream.calls[0].url, `${API_BASE}/${articleLikePath(SLUG)}`);
  const headers = new Headers(upstream.calls[0].init?.headers);
  // The browser cannot attach this itself — that is the whole reason the proxy exists.
  assert.equal(headers.get("authorization"), `Bearer ${TOKENS.accessToken}`);
  assertNoStore(response);
});

test("收藏的 PUT 只转发一个布尔值，且拒绝跨站请求", async () => {
  const upstream = stubFetch({ "api/v1/articles/": () => json({ data: { likeCount: 4, likedByViewer: true } }) });
  const response = await handleArticleLikeRequest(
    likeRequest("PUT", { liked: true, userId: "somebody-else" }),
    { slug: SLUG },
    { apiBaseUrl: API_BASE, fetchImpl: upstream.fetchImpl },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(String(upstream.calls[0].init?.body)), { liked: true }, "nothing but the reader's own choice is forwarded");

  const crossOrigin = await handleArticleLikeRequest(
    likeRequest("PUT", { liked: true }, { origin: "https://evil.test" }),
    { slug: SLUG },
    { apiBaseUrl: API_BASE, fetchImpl: upstream.fetchImpl },
  );
  assert.equal(crossOrigin.status, 403);
  assert.equal(upstream.calls.length, 1, "a cross-origin write never reaches the API");
});

test("收藏的 PUT 拒绝非布尔值与非法 slug，且顺序是先 Origin 后参数", async () => {
  const upstream = stubFetch({ "api/v1/articles/": () => json({ data: {} }) });
  for (const body of [{ liked: "true" }, { liked: 1 }, {}, { like: true }]) {
    const response = await handleArticleLikeRequest(likeRequest("PUT", body), { slug: SLUG }, { apiBaseUrl: API_BASE, fetchImpl: upstream.fetchImpl });
    assert.equal(response.status, 400, `body ${JSON.stringify(body)} is not a like`);
  }
  const badSlug = await handleArticleLikeRequest(likeRequest("PUT", { liked: true }), { slug: "Not A Slug" }, { apiBaseUrl: API_BASE, fetchImpl: upstream.fetchImpl });
  assert.equal(badSlug.status, 400);
  const badLocale = await handleArticleLikeRequest(likeRequest("PUT", { liked: true }), { slug: SLUG, locale: "fr" }, { apiBaseUrl: API_BASE, fetchImpl: upstream.fetchImpl });
  assert.equal(badLocale.status, 400);
  // The Origin check precedes the slug check, so a cross-origin caller cannot use
  // the status code to learn whether a slug exists.
  const crossOriginBadSlug = await handleArticleLikeRequest(
    likeRequest("PUT", { liked: true }, { origin: "https://evil.test" }),
    { slug: "Not A Slug" },
    { apiBaseUrl: API_BASE, fetchImpl: upstream.fetchImpl },
  );
  assert.equal(crossOriginBadSlug.status, 403);
  assert.equal(upstream.calls.length, 0, "none of the refusals became a request");
});

test("关注是 POST，取消关注是 DELETE，都不是一个布尔字段", async () => {
  const upstream = stubFetch({ "api/v1/users/": () => json({ data: { userId: USER_ID, isFollowing: true } }) });
  const follow = await handleUserFollowRequest(
    request(`/api/users/${USER_ID}/follow?locale=en`, {
      method: "POST",
      headers: { host: "no-wave.test", origin: "https://no-wave.test", cookie: `nw_access=${TOKENS.accessToken}` },
    }),
    { userId: USER_ID, locale: "en" },
    { apiBaseUrl: API_BASE, fetchImpl: upstream.fetchImpl },
  );
  assert.equal(follow.status, 200);
  assert.equal(upstream.calls[0].init?.method, "POST");
  assert.equal(upstream.calls[0].url, `${API_BASE}/${userFollowPath(USER_ID, "en")}`);
  assert.equal(new Headers(upstream.calls[0].init?.headers).get("authorization"), `Bearer ${TOKENS.accessToken}`);

  const unfollow = await handleUserFollowRequest(
    request(`/api/users/${USER_ID}/follow`, {
      method: "DELETE",
      headers: { host: "no-wave.test", origin: "https://no-wave.test", cookie: `nw_access=${TOKENS.accessToken}` },
    }),
    { userId: USER_ID },
    { apiBaseUrl: API_BASE, fetchImpl: upstream.fetchImpl },
  );
  assert.equal(unfollow.status, 200);
  assert.equal(upstream.calls[1].init?.method, "DELETE");
  assert.equal(upstream.calls[1].url, `${API_BASE}/${userFollowPath(USER_ID, ENGAGEMENT_DEFAULT_LOCALE)}`);
});

test("关注拒绝 GET、跨站来源与空用户名", async () => {
  const upstream = stubFetch({ "api/v1/users/": () => json({ data: {} }) });
  const get = await handleUserFollowRequest(
    request(`/api/users/${USER_ID}/follow`, { method: "GET", headers: { host: "no-wave.test" } }),
    { userId: USER_ID },
    { apiBaseUrl: API_BASE, fetchImpl: upstream.fetchImpl },
  );
  assert.equal(get.status, 405);

  const crossOrigin = await handleUserFollowRequest(
    request(`/api/users/${USER_ID}/follow`, {
      method: "POST",
      headers: { host: "no-wave.test", origin: "https://evil.test" },
    }),
    { userId: USER_ID },
    { apiBaseUrl: API_BASE, fetchImpl: upstream.fetchImpl },
  );
  assert.equal(crossOrigin.status, 403);

  const empty = await handleUserFollowRequest(
    request(`/api/users/%20/follow`, {
      method: "POST",
      headers: { host: "no-wave.test", origin: "https://no-wave.test" },
    }),
    { userId: "   " },
    { apiBaseUrl: API_BASE, fetchImpl: upstream.fetchImpl },
  );
  assert.equal(empty.status, 400);

  assert.equal(upstream.calls.length, 0, "no refusal reached the API");
});

test("没有配置 API 地址时是 503，而不是一个假的成功", async () => {
  const response = await handleArticleLikeRequest(likeRequest("GET"), { slug: SLUG }, {});
  assert.equal(response.status, 503);
});
